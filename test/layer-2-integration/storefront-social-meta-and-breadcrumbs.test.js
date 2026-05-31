"use strict";
/**
 * Storefront social-share + rich-result correctness — absolute og:image /
 * twitter:image / JSON-LD image, collection + category BreadcrumbList
 * structured data, and dollar-safe CMS head splicing.
 *
 * Three render contracts, exercised against the relevant substrate(s):
 *
 *   1. ABSOLUTE SHARE IMAGE — og:image / twitter:image / the Product
 *      JSON-LD `image` must be FULLY-QUALIFIED URLs. A relative
 *      `/assets/...` value is dropped by every social-share crawler
 *      (Facebook / Slack / Twitter / iMessage) and by Google's product
 *      rich result. We render a PDP with a hero image in BOTH substrates
 *      and assert all three are absolute (start with the canonical https
 *      origin), that the edge + container values are identical, that a
 *      brand-logo-default PDP also absolutizes, and that an already-
 *      absolute value is not double-prefixed.
 *
 *   2. BREADCRUMB JSON-LD — collection + category pages render an on-page
 *      breadcrumb; both must also emit a BreadcrumbList JSON-LD with
 *      absolute item URLs so the rich-result trail surfaces. These pages
 *      are container-only (no edge route), so the assertion runs against
 *      lib/storefront.js.
 *
 *   3. DOLLAR-SAFE CMS HEAD SPLICE — the edge CMS page (worker/render/
 *      pages.js) splices the operator's meta_keywords into the <head>. A
 *      keywords value carrying a literal `$&` must survive verbatim (HTML-
 *      escaped form), not trigger String.replace's replacement-string
 *      dollar substitution.
 *
 * Pure render functions — no DB, no HTTP. The edge ESM modules load via
 * dynamic import behind an `fs.existsSync` guard: `worker/` is excluded
 * from the container build context, so the in-image smoke run skips the
 * edge half (the container half still pins each contract); the full-tree
 * run exercises both.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var path       = require("node:path");
var fs         = require("node:fs");
var nodeModule = require("node:module");
var nodeUrl    = require("node:url");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var manifest = require("../../lib/asset-manifest.json");

var ORIGIN       = "https://shop.example";
var PDP_CANON    = ORIGIN + "/products/widget-pro";
var COL_CANON    = ORIGIN + "/collections/summer";
var CAT_CANON    = ORIGIN + "/categories/apparel";

// The edge render modules import asset-manifest.json with a bare
// `import x from "./asset-manifest.json"` the bundler annotates with the
// `type: "json"` attribute at build time. Register a one-shot resolve hook
// that supplies it so the same source runs unbundled here. Mirrors
// storefront-render-dollar-and-robots.test.js.
var _jsonHookRegistered = false;
function _registerJsonHook() {
  if (_jsonHookRegistered) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  _jsonHookRegistered = true;
}

// Extract the `content="..."` of a named og/twitter meta tag.
function _metaContent(html, attr, name) {
  var re = new RegExp(
    "<meta\\s+" + attr + "=\"" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
    "\"\\s+content=\"([^\"]*)\""
  );
  var m = html.match(re);
  return m ? m[1] : null;
}

function _ogImage(html)      { return _metaContent(html, "property", "og:image"); }
function _twitterImage(html) { return _metaContent(html, "name", "twitter:image"); }

// Pull every `application/ld+json` block's parsed object out of the HTML.
function _jsonLdBlocks(html) {
  var out = [];
  var re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    try { out.push(JSON.parse(m[1].replace(/<\\\/script/g, "</script"))); }
    catch (_e) { /* a non-JSON block is not what we're asserting on */ }
  }
  return out;
}

function _findType(blocks, type) {
  for (var i = 0; i < blocks.length; i += 1) {
    if (blocks[i] && blocks[i]["@type"] === type) return blocks[i];
  }
  return null;
}

function _isAbsoluteHttps(url) {
  return typeof url === "string" && /^https:\/\//.test(url);
}

// ---- shared PDP inputs --------------------------------------------------

var PRODUCT = { id: "p1", slug: "widget-pro", title: "Widget Pro", description: "A fine widget." };
var VARIANTS = [{ id: "v1", sku: "WDG-1", title: "Default", options: {} }];
var PRICES = { v1: { amount_minor: 2999, currency: "USD" } };
var HERO_MEDIA = [{ r2_key: "products/widget-pro.svg", alt_text: "Widget Pro" }];

function _containerPdp(extra) {
  return bShop.storefront.renderProduct(Object.assign({
    product:  PRODUCT,
    variants: VARIANTS,
    prices:   PRICES,
    shop_name: "Acme",
  }, extra || {}));
}

function _assertPdpImagesAbsolute(label, html, expectImage) {
  var og  = _ogImage(html);
  var tw  = _twitterImage(html);
  check(label + ": og:image present",      og !== null);
  check(label + ": twitter:image present", tw !== null);
  check(label + ": og:image is absolute https",      _isAbsoluteHttps(og));
  check(label + ": twitter:image is absolute https", _isAbsoluteHttps(tw));
  check(label + ": og:image === twitter:image",      og === tw);
  if (expectImage) check(label + ": og:image is the expected absolute URL (" + expectImage + ")", og === expectImage);
  // The Product JSON-LD `image` is an array of absolute URLs.
  var blocks  = _jsonLdBlocks(html);
  var product = _findType(blocks, "Product");
  check(label + ": Product JSON-LD present", product !== null);
  check(label + ": Product JSON-LD image is an array", Array.isArray(product.image) && product.image.length > 0);
  check(label + ": Product JSON-LD image[0] is absolute https", _isAbsoluteHttps(product.image[0]));
  check(label + ": Product JSON-LD image[0] === og:image", product.image[0] === og);
  return og;
}

function _assertBreadcrumb(label, html, expectedTrail) {
  var blocks = _jsonLdBlocks(html);
  var crumb  = _findType(blocks, "BreadcrumbList");
  check(label + ": BreadcrumbList JSON-LD present", crumb !== null);
  check(label + ": itemListElement is a non-empty array",
    Array.isArray(crumb.itemListElement) && crumb.itemListElement.length >= 2);
  var ok = true;
  for (var i = 0; i < crumb.itemListElement.length; i += 1) {
    var li = crumb.itemListElement[i];
    if (li["@type"] !== "ListItem") ok = false;
    if (li.position !== i + 1) ok = false;
    if (!_isAbsoluteHttps(li.item)) ok = false;
    if (typeof li.name !== "string" || !li.name.length) ok = false;
  }
  check(label + ": every item is a positioned ListItem with an absolute https URL + a name", ok);
  // The first crumb is always the Shop root at the origin.
  check(label + ": first crumb is Shop at the origin root",
    crumb.itemListElement[0].name === "Shop" &&
    crumb.itemListElement[0].item === ORIGIN + "/");
  if (expectedTrail) {
    var names = crumb.itemListElement.map(function (li) { return li.name; });
    check(label + ": trail names match (" + expectedTrail.join(" -> ") + ")",
      JSON.stringify(names) === JSON.stringify(expectedTrail));
  }
}

async function _run() {
  // ---- BUG 1: container PDP with a hero image — all three images absolute -
  var cPdpHero = _containerPdp({
    media:         HERO_MEDIA,
    asset_prefix:  "/assets/",
    canonical_url: PDP_CANON,
    og_url:        PDP_CANON,
  });
  var cHeroOg = _assertPdpImagesAbsolute("container PDP (hero)", cPdpHero,
    ORIGIN + "/assets/products/widget-pro.svg");

  // ---- BUG 1: container PDP with NO media — brand-logo default absolute --
  var cPdpDefault = _containerPdp({
    canonical_url: PDP_CANON,
    og_url:        PDP_CANON,
  });
  var cDefOg = _ogImage(cPdpDefault);
  check("container PDP (default): og:image is absolute https", _isAbsoluteHttps(cDefOg));
  check("container PDP (default): og:image absolutizes the brand logo",
    cDefOg === ORIGIN + "/assets/brand/logo.png");

  // ---- BUG 1: an already-absolute og_image is NOT double-prefixed --------
  // A page threading an already-fully-qualified og_image (an operator-hosted
  // CDN asset) must pass it through unchanged — the absolutizer prefixes
  // only relative `/`-rooted paths. `_wrap` is the single container head
  // builder; calling it directly exercises the absolutize site.
  var cAbsoluteWrap = bShop.storefront._wrap({
    title:         "X",
    shop_name:     "Acme",
    canonical_url: PDP_CANON,
    og_url:        PDP_CANON,
    og_image:      "https://cdn.example.net/hero.png",
    body:          "<main>x</main>",
  });
  var cAbsOg = _ogImage(cAbsoluteWrap);
  check("_wrap (absolute og_image): og:image is the unchanged absolute URL",
    cAbsOg === "https://cdn.example.net/hero.png");
  check("_wrap (absolute og_image): not double-prefixed with the origin",
    new URL(cAbsOg).origin === "https://cdn.example.net");
  check("_wrap (absolute og_image): twitter:image is the same unchanged absolute URL",
    _twitterImage(cAbsoluteWrap) === "https://cdn.example.net/hero.png");

  // ---- BUG 1: no reliable origin (no canonical_url) + a display-name shop
  // name containing whitespace must NOT emit an invalid "https://Test Shop/
  // ..." URL. With no safe origin the path stays relative (it still resolves
  // against the page on a crawler fetch). Guards the cart and any renderer
  // reached without a canonical URL.
  var cNoOrigin = bShop.storefront._wrap({
    title:     "X",
    shop_name: "Test Shop",
    body:      "<main>x</main>",
  });
  var cNoOriginOg = _ogImage(cNoOrigin);
  check("_wrap (no canonical + display-name shop): og:image is the relative default, not an invalid absolute",
    cNoOriginOg === "/assets/brand/logo.png");
  check("_wrap (no canonical + display-name shop): og:image is not an absolute URL",
    !_isAbsoluteHttps(cNoOriginOg));

  // ---- BUG 2: container collection + category BreadcrumbList JSON-LD -----
  var cCollection = bShop.storefront.renderCollection({
    collection:    { slug: "summer", title: "Summer Drop", description: "Hot picks." },
    products:      [],
    shop_name:     "Acme",
    cart_count:    0,
    canonical_url: COL_CANON,
    og_url:        COL_CANON,
  });
  _assertBreadcrumb("container collection", cCollection, ["Shop", "Collections", "Summer Drop"]);
  check("container collection: breadcrumb collection item URL is absolute + slug-qualified",
    cCollection.indexOf(ORIGIN + "/collections/summer") !== -1);

  var cCategory = bShop.storefront.renderCategory({
    category:      { slug: "apparel", title: "Apparel", active: true },
    breadcrumbs:   [{ slug: "apparel", title: "Apparel" }],
    children:      [],
    shop_name:     "Acme",
    cart_count:    0,
    canonical_url: CAT_CANON,
    og_url:        CAT_CANON,
  });
  _assertBreadcrumb("container category", cCategory, ["Shop", "Categories", "Apparel"]);
  check("container category: breadcrumb category item URL is absolute + slug-qualified",
    cCategory.indexOf(ORIGIN + "/categories/apparel") !== -1);

  // A nested category chain carries each ancestor as a positioned crumb.
  var cCategoryNested = bShop.storefront.renderCategory({
    category:      { slug: "tees", title: "Tees", active: true },
    breadcrumbs:   [{ slug: "apparel", title: "Apparel" }, { slug: "tees", title: "Tees" }],
    children:      [],
    shop_name:     "Acme",
    cart_count:    0,
    canonical_url: ORIGIN + "/categories/tees",
    og_url:        ORIGIN + "/categories/tees",
  });
  _assertBreadcrumb("container category (nested)", cCategoryNested,
    ["Shop", "Categories", "Apparel", "Tees"]);

  // ---- edge half (worker/) — guarded by fs.existsSync --------------------
  var renderDir   = path.resolve(__dirname, "..", "..", "worker", "render");
  var productPath = path.join(renderDir, "product.js");
  var pagesPath   = path.join(renderDir, "pages.js");
  if (!fs.existsSync(productPath) || !fs.existsSync(pagesPath)) {
    // worker/ excluded from the container build context — the container
    // assertions above still pin the contract in the in-image smoke run.
    return;
  }
  _registerJsonHook();
  var edgeProduct = await import(nodeUrl.pathToFileURL(productPath).href);
  var edgePages   = await import(nodeUrl.pathToFileURL(pagesPath).href);

  // ---- BUG 1: edge PDP with a hero image — all three images absolute -----
  var ePdpHero = edgeProduct.renderProduct({
    product:      PRODUCT,
    variants:     VARIANTS,
    prices:       PRICES,
    media:        HERO_MEDIA,
    assetPrefix:  "/assets/",
    shopName:     "Acme",
    canonicalUrl: PDP_CANON,
    ogUrl:        PDP_CANON,
    version:      manifest.version,
  });
  var eHeroOg = _assertPdpImagesAbsolute("edge PDP (hero)", ePdpHero,
    ORIGIN + "/assets/products/widget-pro.svg");

  // ---- BUG 1: dual-render parity — edge + container images identical -----
  check("PDP og:image is byte-identical across substrates", cHeroOg === eHeroOg);
  check("PDP twitter:image is byte-identical across substrates",
    _twitterImage(cPdpHero) === _twitterImage(ePdpHero));
  var cProductImg = _findType(_jsonLdBlocks(cPdpHero), "Product").image[0];
  var eProductImg = _findType(_jsonLdBlocks(ePdpHero), "Product").image[0];
  check("PDP JSON-LD image is byte-identical across substrates", cProductImg === eProductImg);

  // ---- BUG 1: edge PDP with NO media — brand-logo default absolute -------
  var ePdpDefault = edgeProduct.renderProduct({
    product:      PRODUCT,
    variants:     VARIANTS,
    prices:       PRICES,
    shopName:     "Acme",
    canonicalUrl: PDP_CANON,
    ogUrl:        PDP_CANON,
    version:      manifest.version,
  });
  check("edge PDP (default): og:image absolutizes the brand logo",
    _ogImage(ePdpDefault) === ORIGIN + "/assets/brand/logo.png");
  check("edge PDP (default) brand-logo image is byte-identical across substrates",
    _ogImage(ePdpDefault) === cDefOg);

  // ---- BUG 1: edge absolutizer unit contract — only absolutize against a
  // reliable origin. No canonical + a whitespace shop name stays relative
  // (never "https://Test Shop/..."); a host-like shop name or a canonical
  // URL absolutizes; an already-absolute value passes through. Mirrors the
  // container `_absolutizeOgImage` exercised above via `_wrap`.
  var edgeLib = await import(nodeUrl.pathToFileURL(path.join(renderDir, "_lib.js")).href);
  check("edge absolutizeOgImage: no canonical + display-name shop -> relative",
    edgeLib.absolutizeOgImage("/assets/brand/logo.png", "", "Test Shop") === "/assets/brand/logo.png");
  check("edge absolutizeOgImage: no canonical + host-like shop -> shop-host absolute",
    edgeLib.absolutizeOgImage("/assets/brand/logo.png", "", "blamejs.shop") === "https://blamejs.shop/assets/brand/logo.png");
  check("edge absolutizeOgImage: canonical present -> request origin (shop name irrelevant)",
    edgeLib.absolutizeOgImage("/x.png", "https://host.example/p", "Test Shop") === "https://host.example/x.png");
  check("edge absolutizeOgImage: already-absolute value passes through unchanged",
    edgeLib.absolutizeOgImage("https://cdn.example.net/y.png", "", "Test Shop") === "https://cdn.example.net/y.png");

  // ---- BUG 3: edge CMS page head splice — literal $& in meta_keywords ----
  // A keywords value carrying `$&` (and a dollar-backtick) must land
  // literally; String.replace's replacement-string substitution would
  // otherwise expand `$&` to the matched token and `` $` `` to the head.
  var KEYWORDS = "alpha $& bravo $` charlie";
  var edgePage = edgePages.renderStorefrontPage({
    page: {
      slug: "about", title: "About", body: "Body copy.", layout: "default",
      status: "published", updated_at: 0, meta_keywords: KEYWORDS,
    },
    shopName: "Acme",
    version:  manifest.version,
  });
  // The keywords land in a <meta name="keywords" content="..."> tag; the
  // dollar sequences survive verbatim (escapeHtml does not touch `$` or the
  // backtick). The `$&`-expanded form would be the placeholder token text
  // ("RAW_META_KEYWORDS") and a `` $` ``-expanded form would duplicate the
  // page head into the keywords value.
  var kw = _metaContent(edgePage, "name", "keywords");
  check("edge CMS page: keywords meta present", kw !== null);
  check("edge CMS page: literal $& survives in keywords", kw.indexOf("$&") !== -1);
  check("edge CMS page: literal dollar-backtick survives in keywords", kw.indexOf("$`") !== -1);
  check("edge CMS page: keywords value is intact (no expansion)",
    kw.indexOf("alpha") !== -1 && kw.indexOf("bravo") !== -1 && kw.indexOf("charlie") !== -1);
  check("edge CMS page: RAW_META_KEYWORDS token did not leak via $& expansion",
    kw.indexOf("RAW_META_KEYWORDS") === -1);
  // A `` $` `` head-leak would inject the document <head> open tag / <title>
  // into the keywords content; assert neither appears.
  check("edge CMS page: no <title> leaked into keywords via dollar-backtick",
    kw.indexOf("<title>") === -1 && kw.indexOf("title&gt;") === -1);
  // The whole document still has exactly one <head> open tag.
  var headOpens = 0, hi = 0;
  while ((hi = edgePage.indexOf("<head>", hi)) !== -1) { headOpens += 1; hi += 6; }
  check("edge CMS page: exactly one <head> (no head leaked by dollar-backtick)", headOpens === 1);
}

module.exports = { run: _run };
