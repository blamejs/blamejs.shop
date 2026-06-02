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
  // Empty catalog + a wired collection: the storefront shell + hero +
  // supporting sections render, and the dynamic collections band shows the
  // real collection (the band is data-driven now, not a static grid).
  var html = storefront.renderHome({
    products: [],
    collections: [{ slug: "sale", title: "On Sale", description: "Markdowns and clearance." }],
    shop_name: "Acme",
  });
  check("empty home renders dark hero",            html.indexOf("class=\"hero hero--dark\"") !== -1);
  check("empty home has hero code preview",         html.indexOf("class=\"hero__card\"") !== -1);
  check("empty home shows marquee",                 html.indexOf("class=\"marquee\"") !== -1);
  check("empty home shows collections band",       html.indexOf("class=\"collections__grid\"") !== -1);
  check("empty home shows framework band",         html.indexOf("class=\"framework-band\"") !== -1);
  check("empty home renders catalog section",      html.indexOf("class=\"catalog-section\"") !== -1);
  check("empty home shows admin curl snippet",      html.indexOf("class=\"catalog-empty__code\"") !== -1);
  check("empty home anchors at #catalog",          html.indexOf("id=\"catalog\"") !== -1);
}

// UX-1: the home "Featured collections" band is built from real operator
// collections — links to /collections/<slug>, shows operator titles +
// descriptions, rotates the decorative art by index, and DROPS the whole
// band when there are zero collections. The old static /search?q= tiles
// are gone. Operator title/description is cross-customer free-text rendered
// to every visitor, so every value is escaped at the sink (binding XSS rule).
async function _homeCollectionsBand() {
  var html = storefront.renderHome({
    products: [{ slug: "a", title: "Prod A", starting_price_minor: 1999, starting_price_currency: "USD" }],
    collections: [
      { slug: "sale", title: "On Sale", description: "Markdowns and clearance." },
      { slug: "new-in", title: "New In", description: "" },
    ],
    shop_name: "Acme",
  });
  check("band links to the real collection slug",   html.indexOf("href=\"/collections/sale\"") !== -1 &&
                                                     html.indexOf("href=\"/collections/new-in\"") !== -1);
  check("band shows operator collection titles",     html.indexOf("<h3>On Sale</h3>") !== -1 &&
                                                     html.indexOf("<h3>New In</h3>") !== -1);
  check("band shows the description when present",    html.indexOf("<p>Markdowns and clearance.</p>") !== -1);
  check("band omits empty description paragraph",     html.indexOf("<h3>New In</h3>\n        <p>") === -1);
  check("band keeps the collections grid + heading",  html.indexOf("class=\"collections__grid\"") !== -1 &&
                                                      html.indexOf("Browse the catalog by collection.") !== -1);
  check("band rotates the decorative art by index",   html.indexOf("collection-card__art--1") !== -1 &&
                                                      html.indexOf("collection-card__art--2") !== -1);
  // The old hardcoded search-query tiles are gone.
  check("band no longer links /search?q= tiles",      html.indexOf("/search?q=tee") === -1 &&
                                                      html.indexOf("/search?q=license") === -1);

  // Zero collections → the whole band section is dropped (no empty band).
  var none = storefront.renderHome({
    products: [{ slug: "a", title: "Prod A", starting_price_minor: 1999, starting_price_currency: "USD" }],
    collections: [],
    shop_name: "Acme",
  });
  check("zero collections drops the band section",    none.indexOf("class=\"collections\"") === -1 &&
                                                      none.indexOf("class=\"collections__grid\"") === -1);
  // Missing collections opt behaves like an empty list.
  var omitted = storefront.renderHome({ products: [], shop_name: "Acme" });
  check("omitting collections opt drops the band",    omitted.indexOf("class=\"collections__grid\"") === -1);

  // XSS: a <script>/onerror payload in the operator title/description is
  // escaped — no live tag survives to the rendered page.
  var xss = storefront.renderHome({
    products: [],
    collections: [{ slug: "x", title: "<script>alert(1)</script>", description: "\"><img src=x onerror=alert(2)>" }],
    shop_name: "Acme",
  });
  check("band escapes a <script> title",              xss.indexOf("<script>alert(1)</script>") === -1 &&
                                                      xss.indexOf("&lt;script&gt;alert(1)") !== -1);
  check("band escapes an onerror img description",    /<img src=x onerror=/.test(xss) === false);
}

// UX-2 + UX-4: the header nav carries the desktop link row + a CSP-safe
// <details>/<summary> disclosure (the mobile menu, no JS), with Collections
// + Categories links. A pure render (renderHome, unmounted) shows the full
// nav; the route-level conditional only suppresses the links when the mount
// explicitly lacks the dep (asserted in the layer-2 route test).
async function _primaryNav() {
  var html = storefront.renderHome({ products: [], collections: [], shop_name: "Acme" });
  check("nav has the desktop link row",         html.indexOf("<div class=\"site-nav__links\">") !== -1);
  check("nav has Collections link",             html.indexOf("<a class=\"site-nav__link\" href=\"/collections\">Collections</a>") !== -1);
  check("nav has Categories link",              html.indexOf("<a class=\"site-nav__link\" href=\"/categories\">Categories</a>") !== -1);
  check("nav keeps Shop + Framework links",     html.indexOf("href=\"/\">Shop</a>") !== -1 &&
                                                html.indexOf("href=\"/#framework\">Framework</a>") !== -1);
  // The disclosure is a pure-CSS <details>/<summary> — no JS, CSP-safe.
  check("nav has the <details> disclosure",     html.indexOf("<details class=\"site-nav__menu\">") !== -1);
  check("nav summary carries the Menu label",   html.indexOf("<summary class=\"site-nav__menu-toggle\" aria-label=\"Menu\">") !== -1 &&
                                                html.indexOf("<span class=\"site-nav__menu-label\">Menu</span>") !== -1);
  // The disclosure drawer lists the same hrefs as the desktop row so a
  // mobile visitor reaches the full nav.
  check("disclosure drawer lists the same links", html.indexOf("<div class=\"site-nav__drawer\">") !== -1);
  // The nav-scoped link (with the site-nav__link class) appears twice — once
  // in the desktop row, once in the drawer. (The footer's plain Collections
  // link carries no site-nav__link class, so it doesn't inflate the count.)
  function _count(h, n) { var c = 0, i = 0; while ((i = h.indexOf(n, i)) !== -1) { c += 1; i += n.length; } return c; }
  check("drawer mirrors the row (each link twice)", _count(html, "<a class=\"site-nav__link\" href=\"/collections\">Collections</a>") === 2 &&
                                                    _count(html, "<a class=\"site-nav__link\" href=\"/categories\">Categories</a>") === 2);
  // The cart pill the cart-count island reads/writes stays intact.
  check("nav preserves the cart-pill count node", html.indexOf("<span class=\"cart-pill__count\">") !== -1);
}

// UX-5: a multi-variant headline reads "From <lowest>" so it never
// advertises a price that isn't the cheapest buyable variant — even when
// variants[0] is the EXPENSIVE one. Single-variant + all-equal-price keep
// the exact figure. The minimum is taken over integer minor-units, not
// over formatted strings.
async function _fromPriceHeadline() {
  // variants[0] is the expensive one (v0=4999, v1=1999) → "From $19.99".
  var multi = storefront.renderProduct({
    product:  { slug: "p", title: "P", description: "" },
    variants: [{ id: "v0", sku: "A", title: "A" }, { id: "v1", sku: "B", title: "B" }],
    prices:   { v0: { amount_minor: 4999, currency: "USD" }, v1: { amount_minor: 1999, currency: "USD" } },
    shop_name: "Acme",
  });
  var hi = multi.indexOf("<p class=\"featured-product__price\">");
  var headline = multi.slice(hi, multi.indexOf("</p>", hi));
  check("multi-variant headline reads From <lowest>", headline.indexOf("From $19.99") !== -1);
  check("multi-variant headline is NOT the lead price", headline.indexOf("$49.99") === -1);

  // Single variant → exact price, no "From".
  var single = storefront.renderProduct({
    product:  { slug: "p", title: "P", description: "" },
    variants: [{ id: "v0", sku: "A", title: "A" }],
    prices:   { v0: { amount_minor: 4999, currency: "USD" } },
    shop_name: "Acme",
  });
  var si = single.indexOf("<p class=\"featured-product__price\">");
  var sHead = single.slice(si, single.indexOf("</p>", si));
  check("single-variant headline is the exact price",  sHead.indexOf("$49.99") !== -1);
  check("single-variant headline has no From prefix",  sHead.indexOf("From ") === -1);

  // Multi-variant, all equal → exact price, no "From" (noise otherwise).
  var equal = storefront.renderProduct({
    product:  { slug: "p", title: "P", description: "" },
    variants: [{ id: "v0", sku: "A", title: "A" }, { id: "v1", sku: "B", title: "B" }],
    prices:   { v0: { amount_minor: 2999, currency: "USD" }, v1: { amount_minor: 2999, currency: "USD" } },
    shop_name: "Acme",
  });
  var ei = equal.indexOf("<p class=\"featured-product__price\">");
  var eHead = equal.slice(ei, equal.indexOf("</p>", ei));
  check("all-equal-price headline is the exact price",  eHead.indexOf("$29.99") !== -1);
  check("all-equal-price headline has no From prefix",  eHead.indexOf("From ") === -1);
}

// UX-9: the survey required marker uses the accessible screen-reader
// pattern (aria-hidden visual star + .sr-only "(required)"), replacing the
// old <abbr title="Required">. Asserted through renderSurveyPage (which
// wraps _surveyQuestion).
async function _surveyRequiredMarker() {
  var html = storefront.renderSurveyPage({
    state:  "form",
    token:  "tok-1",
    survey: { title: "Feedback", questions: [{ id: "q1", kind: "text", label: "Your name", required: true }] },
    shop_name: "Acme",
  });
  check("survey marker has the aria-hidden visual star", html.indexOf("<span class=\"survey-req\" aria-hidden=\"true\">*</span>") !== -1);
  check("survey marker has the sr-only (required) text",  html.indexOf("<span class=\"sr-only\">(required)</span>") !== -1);
  check("survey marker drops the old abbr title",         html.indexOf("title=\"Required\"") === -1);
  // A non-required question carries no marker.
  var optional = storefront.renderSurveyPage({
    state:  "form",
    token:  "tok-2",
    survey: { title: "Feedback", questions: [{ id: "q1", kind: "text", label: "Optional note", required: false }] },
    shop_name: "Acme",
  });
  check("optional question carries no required marker",   optional.indexOf("class=\"survey-req\"") === -1);
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
  // Backend validates, frontend displays: a sold-out buy box disables the
  // add-to-cart control + shows an honest message — no active purchase the
  // cart-hold path would reject.
  check("sold-out PDP disables add-to-cart",      soldOut.indexOf("disabled aria-disabled=\"true\">Out of stock</button>") !== -1);
  check("sold-out PDP omits active add button",   soldOut.indexOf(">$ add to cart</button>") === -1);
  check("sold-out PDP shows the out-of-stock note", soldOut.indexOf("class=\"pdp__soldout-note\"") !== -1);

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
  check("in-stock PDP keeps active add-to-cart",  inStock.indexOf(">$ add to cart</button>") !== -1);

  // Low stock: a configured threshold the available count sits at/below
  // surfaces the "Only N left" nudge, but the product stays buyable (the
  // CTA is still active — running low is not sold out).
  var low = storefront.renderProduct({
    product:  { slug: "widget-pro", title: "Widget Pro", description: "" },
    variants: [{ id: "v1", sku: "WDG-PRO-BLK-L", title: "Black / Large", requires_shipping: 1 }],
    prices:   { v1: { amount_minor: 2999, currency: "USD" } },
    inventory: { "WDG-PRO-BLK-L": { stock_on_hand: 5, stock_held: 2, low_stock_threshold: 5 } },
    shop_name: "Acme",
  });
  check("low-stock PDP shows Only N left",         low.indexOf("Only 3 left") !== -1);
  check("low-stock PDP uses the low badge",        low.indexOf("pdp__badge--low") !== -1);
  check("low-stock PDP stays buyable (active CTA)", low.indexOf(">$ add to cart</button>") !== -1);
  check("low-stock PDP JSON-LD is InStock",        low.indexOf("schema.org/InStock") !== -1);

  // A threshold the available count is above does NOT trip the nudge —
  // plenty in stock reads as the plain In-stock badge.
  var plenty = storefront.renderProduct({
    product:  { slug: "widget-pro", title: "Widget Pro", description: "" },
    variants: [{ id: "v1", sku: "WDG-PRO-BLK-L", title: "Black / Large", requires_shipping: 1 }],
    prices:   { v1: { amount_minor: 2999, currency: "USD" } },
    inventory: { "WDG-PRO-BLK-L": { stock_on_hand: 50, stock_held: 0, low_stock_threshold: 5 } },
    shop_name: "Acme",
  });
  check("plenty-stock PDP omits the low nudge",    plenty.indexOf("pdp__badge--low") === -1);
  check("plenty-stock PDP shows the In stock badge", plenty.indexOf("pdp__badge--ok") !== -1);

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

// Inputs shared by the container-side "You may also like" test and the
// edge/container byte-identical parity test below.
var _RELATED_OPTS = {
  product: {
    slug:        "widget-pro",
    title:       "Widget Pro",
    description: "The pro variant of the widget.",
  },
  variants: [{ id: "v1", sku: "WDG-PRO-BLK-L", title: "Black / Large" }],
  prices:   { v1: { amount_minor: 2999, currency: "USD" } },
  related: [
    { slug: "widget-lite", title: "Widget Lite", hero_r2_key: "products/widget-lite.svg", hero_alt_text: "Widget Lite art", price_minor: 1999, price_currency: "USD" },
    { slug: "widget-max",  title: "Widget Max",  hero_r2_key: null,                       hero_alt_text: null,             price_minor: 4999, price_currency: "USD" },
  ],
  shop_name: "Acme",
};

// The "You may also like" rail renders the decorated picks as product
// cards (image-bearing + placeholder fallback) and is hidden entirely
// when there are no picks.
async function _productRelated() {
  var html = storefront.renderProduct(Object.assign({}, _RELATED_OPTS));
  check("PDP renders the related section",        html.indexOf("pdp-recommendations") !== -1);
  check("PDP related heading is 'You may also like'", html.indexOf("You may also like") !== -1);
  check("PDP related lists both picks",            html.indexOf("Widget Lite") !== -1 && html.indexOf("Widget Max") !== -1);
  check("PDP related links each pick",             html.indexOf("/products/widget-lite") !== -1 && html.indexOf("/products/widget-max") !== -1);
  check("PDP related shows formatted prices",      html.indexOf("$19.99") !== -1 && html.indexOf("$49.99") !== -1);
  check("PDP related image pick uses hero r2 key", html.indexOf("/assets/products/widget-lite.svg") !== -1);
  check("PDP related no-image pick uses placeholder card", html.indexOf("product-card__media--placeholder") !== -1);
  check("PDP related reuses the catalog grid",     html.indexOf("class=\"grid\"") !== -1);

  // Hidden when there are no picks — no empty rail, no heading.
  var none = storefront.renderProduct(Object.assign({}, _RELATED_OPTS, { related: [] }));
  check("PDP hides related section when empty",    none.indexOf("pdp-recommendations") === -1);
  check("PDP omits related heading when empty",     none.indexOf("You may also like") === -1);

  // Omitting `related` entirely behaves like an empty list.
  var omitted = storefront.renderProduct({
    product:  _RELATED_OPTS.product,
    variants: _RELATED_OPTS.variants,
    prices:   _RELATED_OPTS.prices,
    shop_name: "Acme",
  });
  check("PDP without related opt hides the section", omitted.indexOf("pdp-recommendations") === -1);
}

// Dual-render parity: the PDP markup the container emits and the markup
// the edge Worker emits for the SAME inputs must be byte-identical, so a
// page served from either substrate renders the same "You may also like"
// rail (the asset-fingerprint test enforces the same for the chrome).
// Loads the edge ESM the same way asset-fingerprint.test.js does.
async function _productRelatedParity() {
  var fs       = require("fs");
  var path     = require("path");
  var nodeModule = require("node:module");
  var nodeUrl    = require("node:url");

  var edgeProductPath = path.join(__dirname, "..", "..", "worker", "render", "product.js");
  // worker/ is excluded from the container build context, so the in-image
  // smoke gate doesn't ship the edge modules — skip the parity assertions
  // there (the full-tree CI run, where worker/ IS present, covers them).
  if (!fs.existsSync(edgeProductPath)) return;

  // The edge modules import asset-manifest.json with esbuild's bundler
  // syntax; supply the `type: "json"` import attribute Node's native
  // loader requires so the unbundled source loads here. Idempotent.
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  var edgeProduct = await import(nodeUrl.pathToFileURL(edgeProductPath).href);

  // Container + edge renderers take slightly different opt key casing
  // (snake_case vs camelCase) — feed each its own shape with the SAME
  // product / variants / prices / related data + the same asset prefix.
  var related = _RELATED_OPTS.related;
  var containerHtml = storefront.renderProduct({
    product:      _RELATED_OPTS.product,
    variants:     _RELATED_OPTS.variants,
    prices:       _RELATED_OPTS.prices,
    related:      related,
    shop_name:    "Acme",
    canonical_url: "https://acme.example/products/widget-pro",
  });
  var edgeHtml = edgeProduct.renderProduct({
    product:      _RELATED_OPTS.product,
    variants:     _RELATED_OPTS.variants,
    prices:       _RELATED_OPTS.prices,
    related:      related,
    shopName:     "Acme",
    canonicalUrl: "https://acme.example/products/widget-pro",
    version:      "test",
  });

  function _relatedBlock(html) {
    var start = html.indexOf("<section class=\"catalog-section pdp-recommendations\"");
    if (start === -1) return null;
    var end = html.indexOf("</section>", start);
    return end === -1 ? null : html.slice(start, end + "</section>".length);
  }
  var cBlock = _relatedBlock(containerHtml);
  var eBlock = _relatedBlock(edgeHtml);
  check("container PDP emits the related section",  cBlock !== null);
  check("edge PDP emits the related section",       eBlock !== null);
  check("edge + container related section is byte-identical", cBlock === eBlock);
}

// Dual-render parity for the truthful buy box: the out-of-stock disabled
// CTA + the low-stock "Only N left" nudge must be byte-identical across the
// container + edge substrates (the same enforcement the related-section
// parity test applies to the recommendation rail).
async function _productAvailabilityParity() {
  var fs       = require("fs");
  var path     = require("path");
  var nodeModule = require("node:module");
  var nodeUrl    = require("node:url");

  var edgeProductPath = path.join(__dirname, "..", "..", "worker", "render", "product.js");
  if (!fs.existsSync(edgeProductPath)) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  var edgeProduct = await import(nodeUrl.pathToFileURL(edgeProductPath).href);

  var base = {
    product:  { slug: "widget-pro", title: "Widget Pro", description: "The pro variant of the widget." },
    variants: [{ id: "v1", sku: "WDG-PRO-BLK-L", title: "Black / Large", requires_shipping: 1 }],
    prices:   { v1: { amount_minor: 2999, currency: "USD" } },
  };

  // The PDP buy-box block (.pdp__buybox … through its trailing trust line)
  // is where the stock-driven CTA lives; slice it from both renders.
  function _buyBoxBlock(html) {
    var start = html.indexOf("<div class=\"pdp__buybox\">");
    if (start === -1) return null;
    // The block ends at the availability badges' shipping note placeholder
    // replacement — grab through the trust line's closing div by finding the
    // next "RAW" boundary is brittle, so slice to the shipping note marker.
    var end = html.indexOf("<p class=\"pdp__shipping-note\"", start);
    return end === -1 ? html.slice(start) : html.slice(start, end);
  }
  // The availability badge row (.pdp__meta … In stock / Only N left / Out).
  function _availBlock(html) {
    var marker = "pdp__badge--";
    var idx = html.indexOf(marker);
    if (idx === -1) return null;
    var start = html.lastIndexOf("<div class=\"pdp__meta\">", idx);
    var end = html.indexOf("</div>", idx);
    return (start === -1 || end === -1) ? null : html.slice(start, end + "</div>".length);
  }

  // Out of stock.
  var outInv = { inventory: { "WDG-PRO-BLK-L": { stock_on_hand: 5, stock_held: 5 } } };
  var cOut = storefront.renderProduct(Object.assign({}, base, outInv, { shop_name: "Acme" }));
  var eOut = edgeProduct.renderProduct(Object.assign({}, base, outInv, { shopName: "Acme", version: "test" }));
  check("edge + container sold-out buy box is byte-identical", _buyBoxBlock(cOut) === _buyBoxBlock(eOut));
  check("edge + container sold-out badge is byte-identical",    _availBlock(cOut) === _availBlock(eOut));
  check("container sold-out buy box is disabled",  (_buyBoxBlock(cOut) || "").indexOf("disabled aria-disabled") !== -1);

  // Low stock.
  var lowInv = { inventory: { "WDG-PRO-BLK-L": { stock_on_hand: 4, stock_held: 1, low_stock_threshold: 5 } } };
  var cLow = storefront.renderProduct(Object.assign({}, base, lowInv, { shop_name: "Acme" }));
  var eLow = edgeProduct.renderProduct(Object.assign({}, base, lowInv, { shopName: "Acme", version: "test" }));
  check("edge + container low-stock badge is byte-identical",  _availBlock(cLow) === _availBlock(eLow));
  check("container low-stock badge shows Only 3 left",          (_availBlock(cLow) || "").indexOf("Only 3 left") !== -1);
}

// Dual-render parity for the home collections band + the primary nav.
// The container builds the band + nav from operator data; the edge builds
// them from D1. For the SAME inputs the two markup blocks must be byte-
// identical (the edge renders Collections/Categories unconditionally — the
// container does too on a pure unmounted render, so the headers match).
// The edge home.js import is fs.existsSync-guarded — worker/ is excluded
// from the container build context, so an unguarded import would brick the
// in-image smoke + every deploy.
async function _homeBandNavParity() {
  var fs       = require("fs");
  var path     = require("path");
  var nodeModule = require("node:module");
  var nodeUrl    = require("node:url");

  var edgeHomePath = path.join(__dirname, "..", "..", "worker", "render", "home.js");
  if (!fs.existsSync(edgeHomePath)) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  var edgeHome = await import(nodeUrl.pathToFileURL(edgeHomePath).href);

  var cols = [
    { slug: "sale",   title: "On Sale", description: "Markdowns & clearance." },
    { slug: "new-in", title: "New In",  description: "" },
  ];
  var cHtml = storefront.renderHome({ products: [], collections: cols, shop_name: "Acme" });
  var eHtml = edgeHome.renderHome({ products: [], collections: cols, shopName: "Acme", version: "test" });

  function _bandBlock(html) {
    var start = html.indexOf("<section class=\"collections\"");
    if (start === -1) return null;
    var end = html.indexOf("</section>", start);
    return end === -1 ? null : html.slice(start, end + "</section>".length);
  }
  function _navBlock(html) {
    var start = html.indexOf("<nav class=\"site-nav\"");
    if (start === -1) return null;
    var end = html.indexOf("</nav>", start);
    return end === -1 ? null : html.slice(start, end + "</nav>".length);
  }
  var cBand = _bandBlock(cHtml), eBand = _bandBlock(eHtml);
  check("container home emits the collections band",  cBand !== null);
  check("edge home emits the collections band",        eBand !== null);
  check("edge + container collections band is byte-identical", cBand === eBand);

  var cNav = _navBlock(cHtml), eNav = _navBlock(eHtml);
  check("container home emits the primary nav",        cNav !== null);
  check("edge home emits the primary nav",              eNav !== null);
  check("edge + container primary nav is byte-identical", cNav === eNav);

  // The XSS payload survives byte-identically (escaped) on both substrates.
  var xssCols = [{ slug: "x", title: "<script>alert(1)</script>", description: "\"><img src=x onerror=y>" }];
  var cXss = _bandBlock(storefront.renderHome({ products: [], collections: xssCols, shop_name: "Acme" }));
  var eXss = _bandBlock(edgeHome.renderHome({ products: [], collections: xssCols, shopName: "Acme", version: "test" }));
  check("edge + container escape the band payload identically", cXss === eXss);
  check("band payload has no live <script>/onerror on either",  /<script>alert\(1\)/.test(cXss || "") === false &&
                                                                /<img src=x onerror=/.test(cXss || "") === false);
}

// Dual-render parity for the UX-5 "From <lowest>" buy-box headline: the
// container + edge must emit the same headline price string for the same
// multi-variant inputs.
async function _fromPriceParity() {
  var fs       = require("fs");
  var path     = require("path");
  var nodeModule = require("node:module");
  var nodeUrl    = require("node:url");

  var edgeProductPath = path.join(__dirname, "..", "..", "worker", "render", "product.js");
  if (!fs.existsSync(edgeProductPath)) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  var edgeProduct = await import(nodeUrl.pathToFileURL(edgeProductPath).href);

  var base = {
    product:  { slug: "p", title: "P", description: "d" },
    variants: [{ id: "v0", sku: "A", title: "A" }, { id: "v1", sku: "B", title: "B" }],
    prices:   { v0: { amount_minor: 4999, currency: "USD" }, v1: { amount_minor: 1999, currency: "USD" } },
  };
  function _headline(html) {
    var i = html.indexOf("<p class=\"featured-product__price\">");
    return i === -1 ? null : html.slice(i, html.indexOf("</p>", i) + 4);
  }
  var cH = _headline(storefront.renderProduct(Object.assign({}, base, { shop_name: "Acme" })));
  var eH = _headline(edgeProduct.renderProduct(Object.assign({}, base, { shopName: "Acme", version: "test" })));
  check("container From-price headline present",  (cH || "").indexOf("From $19.99") !== -1);
  check("edge + container From-price headline is byte-identical", cH === eH);
}

// Dual-render parity + functional shape for the no-JS image gallery. A
// multi-image product renders one radio + one stacked main image + one
// `<label for>` thumbnail PER media row (the radio/label `for` wiring is
// what makes the pure-CSS `:checked` swap work — no JS island). The first
// radio is checked, there are exactly N thumbnails (no empty-slot
// padding), and the two substrates emit the gallery byte-for-byte. A
// single-image product renders no thumbnail strip.
async function _productGalleryParity() {
  var fs       = require("fs");
  var path     = require("path");
  var nodeModule = require("node:module");
  var nodeUrl    = require("node:url");

  var edgeProductPath = path.join(__dirname, "..", "..", "worker", "render", "product.js");
  if (!fs.existsSync(edgeProductPath)) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  var edgeProduct = await import(nodeUrl.pathToFileURL(edgeProductPath).href);

  var media = [
    { r2_key: "products/a.svg", alt_text: "Alpha art" },
    { r2_key: "products/b.svg", alt_text: "Beta art" },
    { r2_key: "products/c.svg", alt_text: null },
  ];
  var base = {
    product:  { id: "p1", slug: "widget-pro", title: "Widget Pro", description: "The pro variant of the widget." },
    variants: [{ id: "v1", sku: "WDG-PRO-BLK-L", title: "Black / Large" }],
    prices:   { v1: { amount_minor: 2999, currency: "USD" } },
  };

  // Slice the `.pdp__gallery` block (the figure + radios + thumbnail
  // strip) out of the full page so the parity assertion compares only the
  // gallery markup the two builders produce.
  function _galleryBlock(html) {
    var open = "<div class=\"pdp__gallery\">";
    var start = html.indexOf(open);
    if (start === -1) return null;
    var end = html.indexOf("<div class=\"pdp__info\">", start);
    return end === -1 ? null : html.slice(start + open.length, end);
  }

  var cHtml = storefront.renderProduct(Object.assign({}, base, { media: media, shop_name: "Acme", asset_prefix: "/assets/" }));
  var eHtml = edgeProduct.renderProduct(Object.assign({}, base, { media: media, shopName: "Acme", assetPrefix: "/assets/", version: "test" }));
  var cGal = _galleryBlock(cHtml);
  var eGal = _galleryBlock(eHtml);

  // (a) dual-render parity.
  check("container PDP emits the gallery block",   cGal !== null);
  check("edge PDP emits the gallery block",         eGal !== null);
  check("edge + container PDP gallery is byte-identical", cGal === eGal);

  // (b) exactly N thumbnails, ZERO empty <li> padding.
  function _count(haystack, needle) {
    var n = 0, i = 0;
    while ((i = haystack.indexOf(needle, i)) !== -1) { n += 1; i += needle.length; }
    return n;
  }
  check("gallery renders exactly 3 thumbnail labels", _count(cGal, "<label class=\"pdp__thumb\"") === 3);
  check("gallery has no empty <li> padding",           /<li>\s*<\/li>/.test(cGal) === false);
  check("gallery has exactly 3 list items",            _count(cGal, "<li>") === 3);

  // (c) each thumbnail is a <label for> bound to a radio (interactive,
  //     not a bare img) — the for/id wiring that drives the CSS swap.
  check("thumbnails are labels bound to radios", cGal.indexOf("<label class=\"pdp__thumb\" for=\"pdp-img-0\">") !== -1 &&
                                                  cGal.indexOf("<label class=\"pdp__thumb\" for=\"pdp-img-1\">") !== -1 &&
                                                  cGal.indexOf("<label class=\"pdp__thumb\" for=\"pdp-img-2\">") !== -1);
  check("each label's radio target exists",      cGal.indexOf("id=\"pdp-img-0\"") !== -1 &&
                                                  cGal.indexOf("id=\"pdp-img-1\"") !== -1 &&
                                                  cGal.indexOf("id=\"pdp-img-2\"") !== -1);
  check("thumbnail strip is NOT aria-hidden",    cGal.indexOf("<ul class=\"pdp__thumbs\" aria-hidden") === -1);
  check("thumbnails carry an accessible name",   _count(cGal, "<span class=\"sr-only\">Show image ") === 3);

  // (d) all N images present, each carrying its alt text (the hero uses
  //     its own alt, the alt-less row falls back to the product title).
  check("gallery stacks 3 main images",          _count(cGal, "<img class=\"pdp__img\"") === 3);
  check("hero image carries its alt text",        cGal.indexOf("alt=\"Alpha art\"") !== -1);
  check("second image carries its alt text",      cGal.indexOf("alt=\"Beta art\"") !== -1);
  check("alt-less image falls back to the title", cGal.indexOf("src=\"/assets/products/c.svg\" alt=\"Widget Pro\"") !== -1);
  check("hero loads eager, the rest lazy",        _count(cGal, "loading=\"eager\"") === 1 && _count(cGal, "loading=\"lazy\"") === 2);

  // (e) the first radio is checked on load.
  check("first radio is checked",                 cGal.indexOf("id=\"pdp-img-0\" checked>") !== -1);
  check("only the first radio is checked",         _count(cGal, " checked>") === 1);

  // A single-image product renders the image with NO thumbnail strip.
  var c1 = storefront.renderProduct(Object.assign({}, base, { media: [media[0]], shop_name: "Acme" }));
  var e1 = edgeProduct.renderProduct(Object.assign({}, base, { media: [media[0]], shopName: "Acme", version: "test" }));
  var c1Gal = _galleryBlock(c1);
  check("1-image PDP gallery is byte-identical",  c1Gal === _galleryBlock(e1));
  check("1-image PDP renders no thumbnail strip", c1Gal.indexOf("pdp__thumbs") === -1);
  check("1-image PDP still stacks the one image", _count(c1Gal, "<img class=\"pdp__img\"") === 1);
  check("1-image PDP checks its single radio",     c1Gal.indexOf("id=\"pdp-img-0\" checked>") !== -1);

  // No-media product keeps the letter-mark placeholder with NO thumb strip.
  var c0 = storefront.renderProduct(Object.assign({}, base, { media: [], shop_name: "Acme" }));
  var c0Gal = _galleryBlock(c0);
  check("no-media PDP keeps the placeholder figure", c0Gal.indexOf("pdp__media--placeholder") !== -1);
  check("no-media PDP renders no thumbnail strip",    c0Gal.indexOf("pdp__thumbs") === -1);

  // A product with MORE than 12 media renders at most 12: the CSS picker only
  // maps :checked radios through nth-of-type(12), so a 13th thumbnail would
  // check a radio with no visibility rule and blank the gallery. The builders
  // cap the rendered radios/images/thumbnails to the CSS rule count.
  var many = [];
  for (var mi = 0; mi < 15; mi += 1) many.push({ r2_key: "products/m" + mi + ".svg", alt_text: "Image " + mi });
  var cManyGal = _galleryBlock(storefront.renderProduct(Object.assign({}, base, { media: many, shop_name: "Acme" })));
  var eManyGal = _galleryBlock(edgeProduct.renderProduct(Object.assign({}, base, { media: many, shopName: "Acme", version: "test" })));
  check("over-cap gallery is byte-identical",             cManyGal === eManyGal);
  check("over-cap gallery renders exactly 12 thumbnails", _count(cManyGal, "<label class=\"pdp__thumb\"") === 12);
  check("over-cap gallery stacks exactly 12 images",      _count(cManyGal, "<img class=\"pdp__img\"") === 12);
  check("over-cap gallery has no 13th radio",             cManyGal.indexOf("id=\"pdp-img-12\"") === -1);
  check("over-cap gallery still checks only the first",   _count(cManyGal, " checked>") === 1);
}

// JSON-LD `</script>` breakout neutralization — both render paths.
// Admin-controlled product fields (title / description) flow into the
// Product + BreadcrumbList JSON-LD. The HTML tokenizer ends a <script>
// on `</script` followed by whitespace, `/`, or `>`, so rewriting only
// the exact `</script>` byte sequence would let `</script `, `</script/`,
// `</script\n` break out of the inline JSON-LD block. The renderer
// rewrites every `</script` (any trailing byte) to `<\/script`. Strict
// CSP blocks script execution, so a breakout is markup-injection, not
// XSS — still neutralized. Verified in BOTH substrates (the JSON-LD is
// dual-rendered; the two must agree byte-for-byte).
async function _jsonLdScriptBreakout() {
  var fs       = require("fs");
  var path     = require("path");
  var nodeModule = require("node:module");
  var nodeUrl    = require("node:url");

  // The three breakout variants the old exact-`</script>` rewrite missed,
  // plus the plain closing tag (which both old + new rewrites catch).
  var payloads = [
    "Widget </script ><img src=x>",   // whitespace after the tag name
    "Widget </script/><img src=x>",   // `/` after the tag name
    "Widget </script\n><img src=x>",  // newline after the tag name
    "Widget </script><img src=x>",    // the exact sequence (regression guard)
  ];

  function _jsonLdBlocks(html) {
    // Every <script type="application/ld+json"> … </script> block.
    var re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    var blocks = [];
    var m;
    while ((m = re.exec(html)) !== null) blocks.push(m[1]);
    return blocks;
  }

  function _assertNeutralized(label, html) {
    var blocks = _jsonLdBlocks(html);
    check(label + ": emits at least one JSON-LD block", blocks.length > 0);
    blocks.forEach(function (inner, i) {
      // No raw closing-tag sequence survives inside the JSON-LD payload:
      // `</script` followed by whitespace / `/` / `>` would re-open the
      // tokenizer. The rewrite turns every one into `<\/script`.
      check(label + " block " + i + ": no live </script breakout",
        /<\/script[\s/>]/i.test(inner) === false);
      // The neutralized escape is present where a payload carried one.
      check(label + " block " + i + ": escaped form present when injected",
        inner.indexOf("Widget") === -1 || inner.indexOf("<\\/script") !== -1);
    });
  }

  // Container path.
  payloads.forEach(function (payload) {
    var containerHtml = storefront.renderProduct({
      product:  { slug: "widget-pro", title: payload, description: payload },
      variants: _RELATED_OPTS.variants,
      prices:   _RELATED_OPTS.prices,
      shop_name: "Acme",
      canonical_url: "https://acme.example/products/widget-pro",
    });
    _assertNeutralized("container", containerHtml);
  });

  // Edge path — loaded the same way the related-parity test does. Skipped
  // when worker/ isn't in the build context (in-image smoke); the full
  // tree covers it.
  var edgeProductPath = path.join(__dirname, "..", "..", "worker", "render", "product.js");
  if (!fs.existsSync(edgeProductPath)) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  var edgeProduct = await import(nodeUrl.pathToFileURL(edgeProductPath).href);

  payloads.forEach(function (payload) {
    var edgeHtml = edgeProduct.renderProduct({
      product:  { slug: "widget-pro", title: payload, description: payload },
      variants: _RELATED_OPTS.variants,
      prices:   _RELATED_OPTS.prices,
      shopName: "Acme",
      canonicalUrl: "https://acme.example/products/widget-pro",
      version:  "test",
    });
    _assertNeutralized("edge", edgeHtml);

    // Byte-identical JSON-LD across substrates for the same payload.
    var containerHtml = storefront.renderProduct({
      product:  { slug: "widget-pro", title: payload, description: payload },
      variants: _RELATED_OPTS.variants,
      prices:   _RELATED_OPTS.prices,
      shop_name: "Acme",
      canonical_url: "https://acme.example/products/widget-pro",
    });
    var cBlocks = _jsonLdBlocks(containerHtml);
    var eBlocks = _jsonLdBlocks(edgeHtml);
    check("edge + container emit the same JSON-LD block count", cBlocks.length === eBlocks.length);
    for (var i = 0; i < cBlocks.length && i < eBlocks.length; i += 1) {
      check("edge + container JSON-LD block " + i + " is byte-identical", cBlocks[i] === eBlocks[i]);
    }
  });
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
  // Back-compat caller (no totals_detail) keeps the bare Subtotal + Total list.
  check("cart without detail shows a Total row",  html.indexOf("<dt>Total</dt>") !== -1);
}

// Real grand total before pay: cart with a full totals breakdown (the
// shape the route computes via _estimateCartTotals) renders Subtotal +
// estimated tax + estimated shipping + discount + an Estimated total.
async function _cartTotalsEstimate() {
  var detail = {
    // subtotal 7997, discount 500, tax 656, shipping 695 → grand 9848
    totals: {
      currency: "USD", line_count: 2,
      subtotal_minor: 7997, discount_minor: 500, tax_minor: 656, shipping_minor: 695,
      grand_total_minor: 9848,
    },
    estimated: true, tax_resolved: true, shipping_resolved: true, shipping_label: "Standard",
    destination: { ship_to: { country: "US" }, from_saved: false },
  };
  var html = storefront.renderCart({
    lines:  [
      { variant_id: "v1", sku: "ABC-1", qty: 2, unit_amount_minor: 2999, unit_currency: "USD" },
      { variant_id: "v2", sku: "ABC-2", qty: 1, unit_amount_minor: 1999, unit_currency: "USD" },
    ],
    totals: detail.totals,
    totals_detail: detail,
    shop_name: "Acme",
  });
  check("cart total breakdown shows subtotal",        html.indexOf("$79.97") !== -1);
  check("cart total breakdown shows the discount",     html.indexOf("−$5.00") !== -1);
  check("cart total breakdown shows estimated tax",    /Estimated tax/.test(html) && html.indexOf("$6.56") !== -1);
  check("cart total breakdown shows estimated shipping", /Estimated shipping/.test(html) && html.indexOf("$6.95") !== -1);
  check("cart shows the estimated grand total",        /Estimated total/.test(html) && html.indexOf("$98.48") !== -1);
  check("cart CTA note says the total finalizes at the address step",
    html.indexOf("exact total is confirmed once you enter your shipping address") !== -1);
  // Estimate must NOT present the figure as the final charge.
  check("cart estimate avoids the stale 'next step' microcopy",
    html.indexOf("Tax and shipping are calculated on the next step") === -1);
}

// When tax/shipping can't be resolved (no zone match for the destination,
// tax primitive returned nothing), the figures fall back to a labelled
// "Calculated at checkout" — the subtotal is still honest, nothing faked.
async function _cartTotalsUnresolved() {
  var detail = {
    totals: {
      currency: "USD", line_count: 1,
      subtotal_minor: 2999, discount_minor: 0, tax_minor: 0, shipping_minor: 0,
      grand_total_minor: 2999,
    },
    estimated: true, tax_resolved: false, shipping_resolved: false, shipping_label: null,
    destination: { ship_to: { country: "US" }, from_saved: false },
  };
  var html = storefront.renderCart({
    lines:  [{ variant_id: "v1", sku: "ABC-1", qty: 1, unit_amount_minor: 2999, unit_currency: "USD" }],
    totals: detail.totals,
    totals_detail: detail,
    shop_name: "Acme",
  });
  check("unresolved tax labelled calculated-at-checkout",
    html.indexOf("totals-list__pending") !== -1 && html.indexOf("Calculated at checkout") !== -1);
  check("unresolved cart still shows the honest subtotal", html.indexOf("$29.99") !== -1);
}

// Out-of-stock + low-stock cart lines surface a real status pill instead
// of an implied always-buyable line.
async function _cartLineStock() {
  var html = storefront.renderCart({
    lines: [
      { id: "l1", variant_id: "v1", sku: "OUT-1", qty: 1, unit_amount_minor: 1000, unit_currency: "USD" },
      { id: "l2", variant_id: "v2", sku: "LOW-1", qty: 1, unit_amount_minor: 1000, unit_currency: "USD" },
      { id: "l3", variant_id: "v3", sku: "OK-1",  qty: 1, unit_amount_minor: 1000, unit_currency: "USD" },
    ],
    totals: { subtotal_minor: 3000, grand_total_minor: 3000, currency: "USD" },
    line_stock: { v1: "out", v2: "low", v3: "ok" },
    shop_name: "Acme",
  });
  check("out-of-stock line shows the badge", html.indexOf("cart-line__stock--out") !== -1 && html.indexOf("Out of stock") !== -1);
  check("low-stock line shows the badge",    html.indexOf("cart-line__stock--low") !== -1 && html.indexOf("Low stock") !== -1);
  // The in-stock line carries no pill (the implied default).
  check("in-stock line carries no pill",     (html.match(/cart-line__stock--/g) || []).length === 2);
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
  // Without a totals_detail the summary degrades to a subtotal-only
  // breakdown: tax + shipping labelled "calculated at checkout", and a
  // Total that equals the subtotal (no fabricated number).
  check("checkout (no detail) defers tax/shipping honestly",
    html.indexOf("Calculated at checkout") !== -1);
  check("checkout (no detail) shows a grand Total row", html.indexOf("totals-list__grand") !== -1);

  // With a real totals breakdown (the shape the route computes) the
  // summary shows estimated tax + shipping + the grand total.
  var withTotals = storefront.renderCheckoutForm({
    lines:  [{ variant_id: "v1", sku: "X-1", qty: 2, unit_amount_minor: 2999, unit_currency: "USD", line_total_minor: 5998 }],
    totals: { subtotal_minor: 5998, currency: "USD" },
    totals_detail: {
      totals: {
        currency: "USD", line_count: 1,
        subtotal_minor: 5998, discount_minor: 0, tax_minor: 525, shipping_minor: 695,
        grand_total_minor: 7218,
      },
      estimated: true, tax_resolved: true, shipping_resolved: true, shipping_label: "Standard",
    },
    shop_name: "Acme",
    product_lookup: { v1: { product: { title: "Test Widget", slug: "widget" }, hero_media: null } },
  });
  check("checkout summary shows estimated tax",      /Estimated tax/.test(withTotals) && withTotals.indexOf("$5.25") !== -1);
  check("checkout summary shows estimated shipping", /Estimated shipping/.test(withTotals) && withTotals.indexOf("$6.95") !== -1);
  check("checkout summary shows the grand total",    withTotals.indexOf("$72.18") !== -1);

  // An entered (confirmed) address reads as the EXACT total, not an estimate.
  var confirmed = storefront.renderCheckoutForm({
    lines:  [{ variant_id: "v1", sku: "X-1", qty: 2, unit_amount_minor: 2999, unit_currency: "USD", line_total_minor: 5998 }],
    totals: { subtotal_minor: 5998, currency: "USD" },
    totals_detail: {
      totals: {
        currency: "USD", line_count: 1,
        subtotal_minor: 5998, discount_minor: 0, tax_minor: 525, shipping_minor: 695,
        grand_total_minor: 7218,
      },
      estimated: false, tax_resolved: true, shipping_resolved: true, shipping_label: "Standard",
    },
    shop_name: "Acme",
    product_lookup: { v1: { product: { title: "Test Widget", slug: "widget" }, hero_media: null } },
  });
  check("confirmed checkout shows an exact Tax label (not estimated)",
    confirmed.indexOf("<dt>Tax</dt>") !== -1 && confirmed.indexOf("Estimated tax") === -1);
  check("confirmed checkout note reads as the exact total",
    confirmed.indexOf("Total includes tax and shipping for the address above") !== -1);

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
  // Status timeline + the Request-a-return / Reorder affordances (a paid
  // order is eligible for both).
  check("order page renders status timeline", html.indexOf("order-timeline") !== -1);
  check("paid order offers Request a return", html.indexOf("/account/orders/ord_test/return") !== -1);
  check("paid order offers Reorder",          html.indexOf("/orders/ord_test/reorder") !== -1);
}

// Shipment + carrier tracking panel: a shipment with a known carrier links
// the carrier's public tracking URL; the latest carrier event surfaces.
async function _orderTracking() {
  var html = storefront.renderOrder({
    order: { id: "ord_trk", status: "shipped", currency: "USD",
      subtotal_minor: 2999, tax_minor: 0, shipping_minor: 0, grand_total_minor: 2999,
      lines: [{ sku: "T-1", qty: 1, unit_amount_minor: 2999, unit_currency: "USD", line_total_minor: 2999 }] },
    shipments: [{
      id: "s1", carrier: "ups", status: "in-transit", tracking_number: "1Z999AA10123456784",
      tracking_url: "https://www.ups.com/track?tracknum=1Z999AA10123456784",
      events: [{ status: "in-transit", location: "Louisville, KY" }],
    }],
    shop_name: "Acme",
  });
  check("order page renders tracking panel",  html.indexOf("order-tracking-panel") !== -1);
  check("tracking shows the carrier",          html.indexOf("ups") !== -1);
  check("tracking links the carrier URL",      html.indexOf("ups.com/track") !== -1);
  check("tracking shows the latest event",     html.indexOf("Louisville, KY") !== -1);

  // A cancelled order collapses the timeline + drops the return affordance
  // (a cancelled order can't be returned) but still offers Reorder.
  var cancelled = storefront.renderOrder({
    order: { id: "ord_x", status: "cancelled", currency: "USD",
      subtotal_minor: 1000, tax_minor: 0, shipping_minor: 0, grand_total_minor: 1000,
      lines: [{ sku: "C-1", qty: 1, unit_amount_minor: 1000, unit_currency: "USD", line_total_minor: 1000 }] },
    shop_name: "Acme",
  });
  check("cancelled order shows terminal timeline", cancelled.indexOf("order-timeline--terminal") !== -1);
  check("cancelled order drops return CTA",         cancelled.indexOf("/account/orders/ord_x/return") === -1);
  check("cancelled order keeps Reorder",            cancelled.indexOf("/orders/ord_x/reorder") !== -1);
}

// Order-history list: rows link to each order + carry the per-row Reorder /
// Return affordances; a next-cursor renders a Load-more link.
async function _orderList() {
  var html = storefront.renderOrderList({
    orders: [
      { id: "1111aaaa2222bbbb", status: "delivered", currency: "USD", grand_total_minor: 4999, created_at: 1700000000000 },
      { id: "3333cccc4444dddd", status: "pending",   currency: "USD", grand_total_minor: 1500, created_at: 1700000100000 },
    ],
    next_cursor: "OPAQUE_CURSOR",
    shop_name: "Acme",
  });
  check("order list titled",                  html.indexOf("Your orders") !== -1);
  check("order list links each order",         html.indexOf("/orders/1111aaaa2222bbbb") !== -1);
  check("order list shows totals",             html.indexOf("$49.99") !== -1 && html.indexOf("$15.00") !== -1);
  check("delivered row offers Return",         html.indexOf("/account/orders/1111aaaa2222bbbb/return") !== -1);
  check("delivered row offers Reorder",        html.indexOf("/orders/1111aaaa2222bbbb/reorder") !== -1);
  check("pending row omits Reorder",           html.indexOf("/orders/3333cccc4444dddd/reorder") === -1);
  check("order list renders Load-more pager",  html.indexOf("/account/orders?cursor=OPAQUE_CURSOR") !== -1);

  var empty = storefront.renderOrderList({ orders: [], shop_name: "Acme" });
  check("empty order list shows empty state",  empty.indexOf("No orders yet") !== -1);
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
  check("footer has Shop column",                      html.indexOf(">Shop</h2>") !== -1);
  check("footer has Framework column",                html.indexOf(">Framework</h2>") !== -1);
  check("footer has Your account column",             html.indexOf(">Your account</h2>") !== -1);
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
  await _homeCollectionsBand();
  await _homeBandNavParity();
  await _primaryNav();
  await _fromPriceHeadline();
  await _fromPriceParity();
  await _surveyRequiredMarker();
  await _product();
  await _productAvailability();
  await _productNoVariants();
  await _productRelated();
  await _productRelatedParity();
  await _productAvailabilityParity();
  await _productGalleryParity();
  await _jsonLdScriptBreakout();
  await _cart();
  await _cartTotalsEstimate();
  await _cartTotalsUnresolved();
  await _cartLineStock();
  await _cartEmpty();
  await _checkoutForm();
  await _payPage();
  await _orderPage();
  await _passkeysPage();
  await _passkeyRemoveConfirm();
  await _profilePage();
  await _orderTracking();
  await _orderList();
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
