"use strict";
/**
 * @module shop.storefront
 * @title  Storefront — server-rendered HTML for end customers
 *
 * @intro
 *   v1 ships a minimum viable storefront: read-only HTML routes
 *   for the home page (product list), the product detail page
 *   (PDP), and the cart view. Each renderer is a pure function
 *   returning an HTML string; `mount(router, deps)` wires the
 *   routes into a `b.router` instance and reads data via the
 *   provided catalog / cart primitives.
 *
 *   Templates are inline string templates with the same strict
 *   `{{var}}` renderer the email primitive uses — HTML-escaped
 *   substitution, refusal of unknown / unused placeholders at
 *   composition time. The full theme primitive (with file-backed
 *   templates via `b.template`, asset fingerprinting via
 *   `b.objectStore`, theme inheritance + override resolution) lands
 *   in v1.x; the inline shape exists so the storefront is
 *   demonstrable today.
 *
 *   POST routes (add-to-cart, checkout submit) land in the next
 *   patch alongside the Stripe Elements wiring — v0.0.8 is
 *   read-only HTML.
 */

var emailModule = require("./email");
var pricing      = require("./pricing");

var b = require("./vendor/blamejs");

// Payment-webhook signatures (Stripe's HMAC, PayPal's, …) are computed over
// the EXACT raw request bytes, but the global JSON body-parser reparses and
// discards them. This middleware buffers the raw body for the given POST
// paths into `req.rawBody` BEFORE the body-parser runs, and pre-sets
// `req.body` so the parser short-circuits (its `req.body !== undefined`
// guard) instead of re-reading an already-drained stream. Mount it ahead of
// `b.middleware.bodyParser()`; the webhook handlers read `req.rawBody`.
function webhookRawBodyCapture(paths) {
  var pathSet = {};
  (paths || []).forEach(function (p) { pathSet[p] = true; });
  // Compose the framework's raw body-parser (req.body ← a Buffer of the
  // exact request bytes) instead of hand-reading the stream — it already
  // honours the router's await/next contract and the byte-limit cap.
  // Scoped to the webhook paths and mounted ahead of the global JSON parser:
  // payment webhooks verify the signature over the raw body, which the JSON
  // parser would reparse + discard. The JSON parser then skips these paths
  // via its own `req.body !== undefined` guard.
  var rawParser = b.middleware.bodyParser.raw({
    limit:        b.constants.BYTES.mib(1),
    contentTypes: ["application/json", "application/*"],
  });
  return function (req, res, next) {
    var path = String(req.url || "").split("?")[0];
    if ((req.method || "").toUpperCase() !== "POST" || !pathSet[path]) return next();
    return rawParser(req, res, next);
  };
}

// Re-use the strict renderer from the email primitive (same shape,
// same XSS guard, same unknown / unused refusal).
var _render = emailModule._render;

// ---- shared layout ------------------------------------------------------

// Visual identity reference: the framework ships with two
// reference ecommerce templates (Lager + odor-buyer-file in
// .template/) — the layout below adopts odor's monochrome-plus-
// orange-accent palette (#191919 / #fa4f09 / #ffffff) and
// Montserrat headlines as the default theme. Customers fork the
// theme later by overriding LAYOUT + the per-page templates; the
// theme primitive (v1.x) makes that swap a per-directory drop-in.
//
// Brand assets live under R2 at `brand/<file>` — the layout
// references `/assets/brand/logo.png` which the Worker resolves to
// the bound R2 bucket. The 1536×1024 source PNG is committed
// only to .template/ (local-only) and uploaded once via
// `wrangler r2 object put`.
var LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <title>{{title}} — {{shop_name}}</title>\n" +
  "  <meta name=\"description\" content=\"{{og_description}}\">\n" +
  "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"/assets/brand/favicon.svg\">\n" +
  "  <link rel=\"stylesheet\" href=\"{{theme_css}}\"RAW_CSS_INTEGRITY>\n" +
  "  <meta property=\"og:type\" content=\"{{og_type}}\">\n" +
  "  <meta property=\"og:site_name\" content=\"{{shop_name}}\">\n" +
  "  <meta property=\"og:title\" content=\"{{og_title}}\">\n" +
  "  <meta property=\"og:description\" content=\"{{og_description}}\">\n" +
  "  <meta property=\"og:image\" content=\"{{og_image}}\">\n" +
  "  <meta property=\"og:url\" content=\"{{og_url}}\">\n" +
  "  <meta name=\"twitter:card\" content=\"summary_large_image\">\n" +
  "  <meta name=\"twitter:title\" content=\"{{og_title}}\">\n" +
  "  <meta name=\"twitter:description\" content=\"{{og_description}}\">\n" +
  "  <meta name=\"twitter:image\" content=\"{{og_image}}\">\n" +
  "</head>\n" +
  "<body>\n" +
  "  <a class=\"skip-link\" href=\"#main\">Skip to content</a>\n" +
  "\n" +
  "  <div class=\"utility-bar\" role=\"complementary\">\n" +
  "    <div class=\"utility-bar__inner\">\n" +
  "      <span class=\"utility-bar__pill\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> Open source · Apache 2.0</span>\n" +
  "      <span class=\"utility-bar__msg\">Server-rendered HTML · post-quantum crypto on by default · zero npm runtime deps</span>\n" +
  "      <a class=\"utility-bar__link\" href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">Star on GitHub →</a>\n" +
  "    </div>\n" +
  "  </div>\n" +
  "\n" +
  "  <header class=\"site-header\">\n" +
  "    <div class=\"site-header__inner\">\n" +
  "      <a href=\"/\" class=\"brand\" aria-label=\"{{shop_name}}\"><img src=\"/assets/brand/logo.png\" alt=\"{{shop_name}}\"></a>\n" +
  "      <form class=\"site-search\" action=\"/search\" method=\"get\" role=\"search\">\n" +
  "        <div class=\"site-search__inner\">\n" +
  "          <label for=\"site-search-q\" class=\"skip-link\">Search products</label>\n" +
  "          <svg class=\"site-search__icon\" viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M21 21l-4.35-4.35M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\"/></svg>\n" +
  "          <input id=\"site-search-q\" type=\"search\" name=\"q\" value=\"{{search_q}}\" placeholder=\"Search the catalog\" autocomplete=\"off\" spellcheck=\"false\" maxlength=\"200\">\n" +
  "          <button type=\"submit\">Search</button>\n" +
  "        </div>\n" +
  "      </form>\n" +
  "      <nav class=\"site-nav\" aria-label=\"Primary\">\n" +
  "        <a class=\"site-nav__link\" href=\"/\">Shop</a>\n" +
  "        <a class=\"site-nav__link\" href=\"#framework\">Framework</a>\n" +
  "        <a class=\"site-nav__icon\" href=\"/account\" aria-label=\"Account\"><svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" aria-hidden=\"true\"><path d=\"M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\"/></svg></a>\n" +
  "        <a class=\"cart-pill\" href=\"/cart\" aria-label=\"Cart, {{cart_count}} items\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M3 4h2l2.4 12.1a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 1.95-1.55L21 8H6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><circle cx=\"10\" cy=\"21\" r=\"1.4\" fill=\"currentColor\"/><circle cx=\"17\" cy=\"21\" r=\"1.4\" fill=\"currentColor\"/></svg><span class=\"cart-pill__count\">{{cart_count}}</span></a>\n" +
  "      </nav>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "\n" +
  "  <main id=\"main\">{{body}}</main>\n" +
  "\n" +
  "  <section class=\"newsletter-band\" aria-labelledby=\"newsletter-title\">\n" +
  "    <div class=\"newsletter-band__inner\">\n" +
  "      <div class=\"newsletter-band__copy\">\n" +
  "        <p class=\"eyebrow eyebrow--on-dark\">Stay in the loop</p>\n" +
  "        <h2 id=\"newsletter-title\">Get release notes the day they ship.</h2>\n" +
  "        <p class=\"newsletter-band__lede\">No marketing emails. A single short note when there's a new framework release, a security advisory, or a primitive worth knowing about.</p>\n" +
  "      </div>\n" +
  "      <form class=\"newsletter-band__form\" method=\"post\" action=\"/newsletter\">\n" +
  "        <label class=\"skip-link\" for=\"newsletter-email\">Email address</label>\n" +
  "        <input id=\"newsletter-email\" type=\"email\" name=\"email\" required placeholder=\"you@example.com\" autocomplete=\"email\">\n" +
  "        <button type=\"submit\">Subscribe</button>\n" +
  "      </form>\n" +
  "    </div>\n" +
  "  </section>\n" +
  "\n" +
  "  <footer class=\"site-footer\">\n" +
  "    <div class=\"site-footer__inner\">\n" +
  "      <div class=\"site-footer__brand-col\">\n" +
  "        <img class=\"site-footer__logo\" src=\"/assets/brand/logo.png\" alt=\"{{shop_name}}\">\n" +
  "        <p class=\"site-footer__tagline\">An open-source shop framework — server-rendered HTML, zero npm runtime dependencies, security defaults on.</p>\n" +
  "        <ul class=\"site-footer__social\" aria-label=\"Project links\">\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\" aria-label=\"GitHub\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.4-1.3-1.8-1.3-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11 11 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.3v3.4c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z\" fill=\"currentColor\"/></svg></a></li>\n" +
  "          <li><a href=\"https://npmjs.com/package/blamejs\" rel=\"noopener\" aria-label=\"npm\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M2 7v10h6v-7h3v7h11V7H2Zm15 8h-2v-5h-3v5h-1V9h6v6Z\" fill=\"currentColor\"/></svg></a></li>\n" +
  "          <li><a href=\"/feed.xml\" aria-label=\"RSS feed\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M5 4v3a13 13 0 0 1 13 13h3A16 16 0 0 0 5 4Zm0 6v3a7 7 0 0 1 7 7h3a10 10 0 0 0-10-10Zm1 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z\" fill=\"currentColor\"/></svg></a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h4>Shop</h4>\n" +
  "        <ul>\n" +
  "          <li><a href=\"/\">All products</a></li>\n" +
  "          <li><a href=\"/collections\">Collections</a></li>\n" +
  "          <li><a href=\"/?sort=new\">New arrivals</a></li>\n" +
  "          <li><a href=\"/?sort=sale\">On sale</a></li>\n" +
  "          <li><a href=\"/cart\">Cart</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h4>Framework</h4>\n" +
  "        <ul>\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">Source on GitHub</a></li>\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs\" rel=\"noopener\">blamejs core</a></li>\n" +
  "          <li><a href=\"/SECURITY.md\">Security policy</a></li>\n" +
  "          <li><a href=\"/CHANGELOG.md\">Changelog</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h4>Operators</h4>\n" +
  "        <ul>\n" +
  "          <li><a href=\"/account\">Account</a></li>\n" +
  "          <li><a href=\"/orders\">Orders</a></li>\n" +
  "          <li><a href=\"/admin\">Admin</a></li>\n" +
  "          <li><a href=\"mailto:hello@blamejs.shop\">Contact</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "    </div>\n" +
  "    <div class=\"site-footer__copy\">\n" +
  "      <p>&copy; {{year}} {{shop_name}} — built on blamejs · Apache 2.0 licensed.</p>\n" +
  "      <ul>\n" +
  "        <li><a href=\"/SECURITY.md\">Security</a></li>\n" +
  "        <li><a href=\"/privacy\">Privacy</a></li>\n" +
  "        <li><a href=\"/terms\">Terms</a></li>\n" +
  "      </ul>\n" +
  "    </div>\n" +
  "  </footer>\n" +
  "</body>\n" +
  "</html>\n";

// Default theme stylesheet URL. Operators pass `opts.theme_css` (or
// `opts.theme.assetUrl("css/main.css")` via the theme primitive) on
// each render call to override; absent that, every storefront page
// references the shipped default theme — so a fresh install renders
// styled out of the box without any wiring.
// Asset integrity + version manifest — sha384 digests + the release
// version, baked at build time (scripts/generate-asset-manifest.js) and
// committed. Read here instead of hashing the files at render time so the
// integrity attribute and the cache-buster are present in every runtime,
// including the container image and the edge Worker, neither of which
// ships the theme asset files to hash live. See lib/asset-manifest.json.
var _assetManifest = require("./asset-manifest.json");

// The default theme stylesheet ships from R2 at this path. The
// `?v=` query is a build-time cache-buster — operator uploads to R2
// rewrite the bytes at the same path, and without the version
// param browsers happily serve the previous cached CSS for the
// five-minute default TTL. The manifest version bumps each release,
// forcing every active session to re-fetch.
var DEFAULT_THEME_CSS_URL = "/assets/themes/default/css/main.css?v=" + _assetManifest.version;

// Footer copyright year — resolved once at module load. It's a near-static
// value (changes once a year); a `new Date()` allocation on every page
// render was wasteful. Containers are long-lived and restart often enough
// that a year-boundary staleness window doesn't matter for a copyright line.
var _COPYRIGHT_YEAR = String(new Date().getUTCFullYear());

// Client "island" scripts are served as external assets (same `?v=` cache-
// bust as the CSS), never inline — the storefront's strict `script-src
// 'self'` CSP blocks inline <script>, so an inline island silently fails
// in production. `'self'` allows these /assets/ files; the R2 asset sync
// (npm run sync-assets) uploads them alongside the stylesheets.
var _ASSET_JS_VERSION = _assetManifest.version;

// Subresource Integrity for the static assets — the browser refuses to
// run/apply a resource whose served bytes don't match (defense against an
// R2/edge compromise or on-path injection). The sha384 digest (W3C SRI
// 1.0) is read from the build-time manifest keyed by the path under the
// default theme's asset root; an absent key (a custom operator theme,
// whose bytes aren't ours to hash) yields no attribute. Same-origin, so
// no `crossorigin` is required for the check to run.
function _assetSri(relUnderThemeAssets) {
  return _assetManifest.assets[relUnderThemeAssets] || null;
}
function _islandScript(name) {
  var sri = _assetSri("js/" + name);
  return "<script src=\"/assets/themes/default/js/" + name + "?v=" + _ASSET_JS_VERSION + "\"" +
    (sri ? " integrity=\"" + sri + "\"" : "") + " defer></script>";
}

function _wrap(opts) {
  var themeCss = (opts && typeof opts.theme_css === "string" && opts.theme_css.length)
    ? opts.theme_css
    : DEFAULT_THEME_CSS_URL;
  // SRI for the stylesheet — only for the default theme CSS we ship (and
  // can hash); a custom operator-supplied `theme_css` is their asset with
  // an unknown body, so it's left without an integrity attribute.
  var cssSri = (themeCss === DEFAULT_THEME_CSS_URL) ? _assetSri("css/main.css") : null;
  var themeCssIntegrity = cssSri ? " integrity=\"" + cssSri + "\"" : "";
  // OpenGraph / Twitter Card defaults — every page sets reasonable
  // fallbacks; per-page renderers (PDP, etc.) can override via
  // `opts.og_*` for a product-specific share preview.
  var shopName = opts.shop_name || "blamejs.shop";
  var ogType        = opts.og_type        || "website";
  var ogTitle       = opts.og_title       || (opts.title ? opts.title + " — " + shopName : shopName);
  var ogDescription = opts.og_description || "Open-source ecommerce framework built on blamejs. Server-rendered HTML, post-quantum crypto, zero npm runtime dependencies.";
  var ogImage       = opts.og_image       || "/assets/brand/logo.png";
  var ogUrl         = opts.og_url         || "";
  return _render(LAYOUT, {
    title:          opts.title,
    shop_name:      shopName,
    cart_count:     opts.cart_count == null ? 0 : opts.cart_count,
    year:           _COPYRIGHT_YEAR,
    search_q:       opts.search_q == null ? "" : opts.search_q,
    theme_css:           themeCss,
    og_type:        ogType,
    og_title:       ogTitle,
    og_description: ogDescription,
    og_image:       ogImage,
    og_url:         ogUrl,
    body:           "RAW_BODY_PLACEHOLDER",
  }).replace("RAW_CSS_INTEGRITY", themeCssIntegrity).replace("RAW_BODY_PLACEHOLDER", opts.body);
  // The body is RAW HTML (already rendered + escaped at the
  // per-fragment level). The placeholder swap is post-render so the
  // outer renderer's HTML-escape doesn't double-escape the inner
  // markup. `search_q` is HTML-escaped by the renderer like any
  // other placeholder, so a customer-supplied query like
  // `"><script>` lands as escaped text inside the input's `value`.
}

// ---- home --------------------------------------------------------------

// PRODUCT_CARD has two flavors composed at render time —
// `_buildProductCard()` picks between them based on whether the
// product carries a media row. The image-bearing card uses an
// anchor-wrapper so the whole tile is clickable; the text-only
// fallback keeps the existing link inside the card body.
var PRODUCT_CARD_IMAGE =
  "<a class=\"product-card\" href=\"/products/{{slug}}\">\n" +
  "  <figure class=\"product-card__media\">\n" +
  "    <img src=\"{{image_url}}\" alt=\"{{image_alt}}\" loading=\"lazy\">\n" +
  "  </figure>\n" +
  "  <div class=\"product-card__meta\">\n" +
  "    <h3 class=\"product-card__title\">{{title}}</h3>\n" +
  "    <p class=\"product-card__price\">{{price}}</p>\n" +
  "  </div>\n" +
  "</a>\n";

var PRODUCT_CARD =
  "<div class=\"card\">\n" +
  "  <h2>{{title}}</h2>\n" +
  "  <p class=\"price\">{{price}}</p>\n" +
  "  <a href=\"/products/{{slug}}\" class=\"card-link\">View product →</a>\n" +
  "</div>\n";

// Render-time picker. Image-bearing cards become the dominant
// surface as soon as a product carries media; text-only cards
// remain the fallback so a freshly-listed product doesn't render
// an empty image slot.
function _buildProductCard(p) {
  if (p.image_url) {
    return _render(PRODUCT_CARD_IMAGE, {
      title:     p.title,
      price:     p.price,
      slug:      p.slug,
      image_url: p.image_url,
      image_alt: p.image_alt || p.title,
    });
  }
  return _render(PRODUCT_CARD, {
    title: p.title,
    price: p.price,
    slug:  p.slug,
  });
}

var HOME_HERO =
  "<section class=\"hero hero--dark\">\n" +
  "  <div class=\"hero__bg\" aria-hidden=\"true\">\n" +
  "    <div class=\"hero__grid\"></div>\n" +
  "    <div class=\"hero__glow hero__glow--1\"></div>\n" +
  "    <div class=\"hero__glow hero__glow--2\"></div>\n" +
  "  </div>\n" +
  "  <div class=\"hero__inner\">\n" +
  "    <div class=\"hero__copy\">\n" +
  "      <p class=\"eyebrow eyebrow--on-dark\"><span class=\"dot dot--accent\" aria-hidden=\"true\"></span> Open-source ecommerce framework · v" + require("../package.json").version + "</p>\n" +
  "      <h1 class=\"hero__title\">Run a shop that owes <span class=\"accent\">nothing</span> to the dependency graph.</h1>\n" +
  "      <p class=\"hero__lede\">Server-rendered HTML. Post-quantum crypto on by default. Zero npm runtime dependencies. Every primitive is composed from a single vendored framework — no transitive supply chain to audit.</p>\n" +
  "      <div class=\"hero__cta\">\n" +
  "        <a href=\"#catalog\" class=\"btn-primary\">Browse the shop <span aria-hidden=\"true\">→</span></a>\n" +
  "        <a href=\"https://github.com/blamejs/blamejs.shop\" class=\"btn-ghost btn-ghost--on-dark\" rel=\"noopener\">View on GitHub</a>\n" +
  "      </div>\n" +
  "      <dl class=\"hero__stats\">\n" +
  "        <div><dt>Products live</dt><dd>{{product_count}}</dd></div>\n" +
  "        <div><dt>npm runtime deps</dt><dd>0</dd></div>\n" +
  "        <div><dt>Default crypto</dt><dd>PQC</dd></div>\n" +
  "        <div><dt>License</dt><dd>Apache 2.0</dd></div>\n" +
  "      </dl>\n" +
  "    </div>\n" +
  "    <aside class=\"hero__card\" aria-label=\"Storefront preview\">\n" +
  "      <div class=\"hero__card-bar\">\n" +
  "        <span class=\"hero__card-dot hero__card-dot--r\"></span>\n" +
  "        <span class=\"hero__card-dot hero__card-dot--y\"></span>\n" +
  "        <span class=\"hero__card-dot hero__card-dot--g\"></span>\n" +
  "        <span class=\"hero__card-url\">blamejs.shop / order / o-42</span>\n" +
  "      </div>\n" +
  "      <pre class=\"hero__card-body\"><code><span class=\"tk-c\">// Server-rendered order page</span>\n" +
  "<span class=\"tk-k\">var</span> bShop = <span class=\"tk-f\">require</span>(<span class=\"tk-s\">\"./lib\"</span>);\n" +
  "\n" +
  "bShop.checkout.<span class=\"tk-f\">finalize</span>({\n" +
  "  cart_id:        <span class=\"tk-s\">\"c_2024\"</span>,\n" +
  "  payment_intent: <span class=\"tk-s\">\"pi_3RtA…\"</span>,\n" +
  "  cursor_secret:  <span class=\"tk-f\">b.crypto.namespaceHash</span>(\n" +
  "    <span class=\"tk-s\">\"order-cursor\"</span>, secret),\n" +
  "}).<span class=\"tk-f\">then</span>(<span class=\"tk-k\">function</span> (o) {\n" +
  "  res.<span class=\"tk-f\">setHeader</span>(<span class=\"tk-s\">\"content-type\"</span>,\n" +
  "    <span class=\"tk-s\">\"text/html; charset=utf-8\"</span>);\n" +
  "  res.<span class=\"tk-f\">end</span>(storefront.<span class=\"tk-f\">renderOrder</span>(o));\n" +
  "});</code></pre>\n" +
  "    </aside>\n" +
  "  </div>\n" +
  "</section>\n" +
  "\n" +
  "<section class=\"marquee\" aria-hidden=\"true\">\n" +
  "  <div class=\"marquee__track\">\n" +
  "    <span>ML-KEM-1024 key agreement</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>ML-DSA-65 signatures</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>XChaCha20-Poly1305 sealed sessions</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Argon2id passphrase hashing</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>SHAKE256 KDF</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Stripe-first payments</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>WebAuthn passkeys</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>SLSA L3 provenance</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Sigstore-keyless SBOM</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Trusted Types enforced</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Server-rendered HTML</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Zero npm runtime deps</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">ML-KEM-1024 key agreement</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">ML-DSA-65 signatures</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">XChaCha20-Poly1305 sealed sessions</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Argon2id passphrase hashing</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">SHAKE256 KDF</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Stripe-first payments</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">WebAuthn passkeys</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">SLSA L3 provenance</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Sigstore-keyless SBOM</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Trusted Types enforced</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Server-rendered HTML</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Zero npm runtime deps</span><span class=\"marquee__sep\">◆</span>\n" +
  "  </div>\n" +
  "</section>\n" +
  "\n" +
  "RAW_FEATURED_CALLOUT\n" +
  "\n" +
  "<section class=\"collections\" aria-labelledby=\"collections-title\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Featured collections</p>\n" +
  "    <h2 id=\"collections-title\" class=\"section-head__title\">Shaped for a storefront that ships from day one.</h2>\n" +
  "    <p class=\"section-head__lede\">Drop products into any of these starting categories — or define your own taxonomy through the catalog admin and the framework will server-render the grids, filters, and PDP routes for free.</p>\n" +
  "  </header>\n" +
  "  <div class=\"collections__grid\">\n" +
  "    <a class=\"collection-card\" href=\"/search?q=tee\">\n" +
  "      <div class=\"collection-card__art collection-card__art--1\" aria-hidden=\"true\"></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Apparel</h3>\n" +
  "        <p>Sized, colored, inventoried.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "    <a class=\"collection-card\" href=\"/search?q=edge\">\n" +
  "      <div class=\"collection-card__art collection-card__art--2\" aria-hidden=\"true\"></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Hardware</h3>\n" +
  "        <p>Serialized, warranty-tracked.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "    <a class=\"collection-card\" href=\"/search?q=license\">\n" +
  "      <div class=\"collection-card__art collection-card__art--3\" aria-hidden=\"true\"></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Digital</h3>\n" +
  "        <p>License-key fulfillment.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "    <a class=\"collection-card\" href=\"/search?q=subscription\">\n" +
  "      <div class=\"collection-card__art collection-card__art--4\" aria-hidden=\"true\"></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Subscriptions</h3>\n" +
  "        <p>Stripe-backed recurring.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "    <a class=\"collection-card\" href=\"/search?q=bundle\">\n" +
  "      <div class=\"collection-card__art collection-card__art--5\" aria-hidden=\"true\"></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Bundles</h3>\n" +
  "        <p>Composite SKUs, atomic stock.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "    <a class=\"collection-card\" href=\"/search?q=gift\">\n" +
  "      <div class=\"collection-card__art collection-card__art--6\" aria-hidden=\"true\"></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Gift cards</h3>\n" +
  "        <p>PQC-signed redemption codes.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "  </div>\n" +
  "</section>\n" +
  "\n" +
  "<section id=\"framework\" class=\"framework-band\" aria-labelledby=\"framework-title\">\n" +
  "  <div class=\"framework-band__inner\">\n" +
  "    <div class=\"framework-band__copy\">\n" +
  "      <p class=\"eyebrow\">Built on blamejs</p>\n" +
  "      <h2 id=\"framework-title\">Every behavior on this site is a composed primitive.</h2>\n" +
  "      <p class=\"framework-band__lede\">Twenty-plus shop primitives — cart, catalog, payment, order, subscriptions, customers, webhooks, audit log, sealed sessions, signed cursors, problem-details, money math, FSMs — sit on a vendored blamejs core that ships hundreds more. They compose. Replacing one doesn't fork the others.</p>\n" +
  "      <a class=\"link-arrow\" href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">Read the source on GitHub <span aria-hidden=\"true\">→</span></a>\n" +
  "    </div>\n" +
  "    <ul class=\"framework-band__list\">\n" +
  "      <li>\n" +
  "        <span class=\"framework-band__num\">01</span>\n" +
  "        <h3>Server-rendered HTML</h3>\n" +
  "        <p>Every route renders a complete document at the origin. No client framework, no hydration spinner, no JavaScript required to read the page.</p>\n" +
  "      </li>\n" +
  "      <li>\n" +
  "        <span class=\"framework-band__num\">02</span>\n" +
  "        <h3>PQC-first crypto</h3>\n" +
  "        <p>ML-KEM-1024, ML-DSA-65, XChaCha20-Poly1305, SHAKE256, HKDF-SHA3-512, Argon2id. The application never reaches for AES-GCM, SHA-256, or classical ECDH on its own.</p>\n" +
  "      </li>\n" +
  "      <li>\n" +
  "        <span class=\"framework-band__num\">03</span>\n" +
  "        <h3>Zero runtime npm deps</h3>\n" +
  "        <p>One vendored framework, shipped byte-for-byte from a signed release tag. The tarball you install is the tarball that ran in CI.</p>\n" +
  "      </li>\n" +
  "      <li>\n" +
  "        <span class=\"framework-band__num\">04</span>\n" +
  "        <h3>Security defaults on</h3>\n" +
  "        <p>CSRF, fetch-metadata, origin, bot-guard, sealed cookies, Trusted Types, DoH, cookie-prefix policy — composed into the request lifecycle, not behind a feature flag.</p>\n" +
  "      </li>\n" +
  "    </ul>\n" +
  "  </div>\n" +
  "</section>\n";

var CATALOG_EMPTY =
  "<section id=\"catalog\" class=\"catalog-section\">\n" +
  "  <header class=\"section-head section-head--with-link\">\n" +
  "    <div>\n" +
  "      <p class=\"eyebrow\">Catalog</p>\n" +
  "      <h2 class=\"section-head__title\">The shop is open, waiting on its first listing.</h2>\n" +
  "      <p class=\"section-head__lede\">When you add a product through the admin API, it appears here in a server-rendered grid with filters, sorting, and a fully-routed PDP. Until then, this is the storefront shell.</p>\n" +
  "    </div>\n" +
  "    <a class=\"link-arrow\" href=\"/admin\">Open admin <span aria-hidden=\"true\">→</span></a>\n" +
  "  </header>\n" +
  "  <div class=\"catalog-empty\">\n" +
  "    <div class=\"catalog-empty__placeholder\" aria-hidden=\"true\">\n" +
  "      <span></span><span></span><span></span><span></span>\n" +
  "    </div>\n" +
  "    <div class=\"catalog-empty__copy\">\n" +
  "      <h3>Add the first product</h3>\n" +
  "      <p>The grid below renders as soon as a product is listed. Variants, prices, inventory levels, and tax categories are all wired up — you just supply the SKUs.</p>\n" +
  "      <pre class=\"catalog-empty__code\"><code>curl -X POST https://blamejs.shop/admin/products \\\n  -H \"authorization: Bearer $ADMIN_API_KEY\" \\\n  -d '{ \"title\": \"My first product\", \"slug\": \"first\" }'</code></pre>\n" +
  "    </div>\n" +
  "  </div>\n" +
  "</section>\n";

var CATALOG_HEAD =
  "<section id=\"catalog\" class=\"catalog-section\">\n" +
  "  <header class=\"section-head section-head--with-link\">\n" +
  "    <div>\n" +
  "      <p class=\"eyebrow\">Catalog</p>\n" +
  "      <h2 class=\"section-head__title\">Products in store</h2>\n" +
  "      <p class=\"section-head__lede\">Server-rendered listings — every card, price, and link arrived on the wire as complete HTML.</p>\n" +
  "    </div>\n" +
  "    <a class=\"link-arrow\" href=\"/?sort=new\">New arrivals <span aria-hidden=\"true\">→</span></a>\n" +
  "  </header>\n" +
  "  <div class=\"grid\">{{cards}}</div>\n" +
  "</section>\n";

function renderHome(opts) {
  if (!opts || !Array.isArray(opts.products)) throw new TypeError("storefront.renderHome: opts.products required");
  var shopName  = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  var title     = opts.title || "Shop";
  var assetPrefix = opts.asset_prefix || "/assets/";
  var products    = opts.products.map(function (p) {
    var priceStr = p.starting_price_minor != null
      ? pricing.format(p.starting_price_minor, p.starting_price_currency || "USD")
      : "—";
    // Hero image — first media row attached to the product (the
    // route handler bundles it in via `p.hero_media`). Image-less
    // products render the text-only PRODUCT_CARD fallback below.
    var imageUrl = p.hero_media ? assetPrefix + p.hero_media.r2_key : null;
    var imageAlt = p.hero_media ? (p.hero_media.alt_text || p.title) : null;
    return {
      title:       p.title,
      description: p.description || "",
      price:       priceStr,
      slug:        p.slug,
      image_url:   imageUrl,
      image_alt:   imageAlt,
    };
  });
  if (opts.theme) {
    return opts.theme.render("home", {
      title:           title,
      shop_name:       shopName,
      cart_count:      cartCount,
      products:        products,
      has_products:    products.length > 0,
      asset_css_main:  opts.theme.assetUrl("css/main.css"),
    });
  }
  var cards = products.map(function (p) { return _buildProductCard(p); }).join("\n");
  var catalog = products.length === 0
    ? CATALOG_EMPTY
    : _render(CATALOG_HEAD, { cards: "RAW_CARDS_PLACEHOLDER" }).replace("RAW_CARDS_PLACEHOLDER", cards);
  // Live stat in the hero — operator-facing visitors see the
  // actual catalog size, not a stale hardcoded number. Falls back
  // to a typographic em-dash when the catalog hasn't been seeded.
  var heroProductCount = products.length === 0 ? "—" : String(products.length);

  // Featured-product callout — pick the first product that has
  // attached media. Surfaces a single product in a wider treatment
  // than the dense 6-tile collections grid below. Operators that
  // want a different selection rule (top-seller, newest, manually
  // pinned) wrap renderHome and override `opts.featured`.
  function _esc(s) { return b.template.escapeHtml(s); }
  var featuredProduct = null;
  if (opts.featured) {
    featuredProduct = opts.featured;
  } else {
    for (var fi = 0; fi < products.length; fi += 1) {
      if (products[fi].image_url) { featuredProduct = products[fi]; break; }
    }
  }
  var featuredHtml = "";
  if (featuredProduct) {
    var fpDesc = featuredProduct.description || "Server-rendered, PQC-secured, shipped from origin. Composed on the vendored blamejs framework.";
    featuredHtml =
      "<section class=\"featured-product\" aria-labelledby=\"featured-title\">\n" +
      "  <div class=\"featured-product__inner\">\n" +
      "    <a class=\"featured-product__media\" href=\"/products/" + _esc(featuredProduct.slug) + "\">\n" +
      "      <img src=\"" + _esc(featuredProduct.image_url) + "\" alt=\"" + _esc(featuredProduct.image_alt || featuredProduct.title) + "\" loading=\"lazy\">\n" +
      "    </a>\n" +
      "    <div class=\"featured-product__copy\">\n" +
      "      <p class=\"eyebrow\">Featured</p>\n" +
      "      <h2 id=\"featured-title\" class=\"featured-product__title\">" + _esc(featuredProduct.title) + "</h2>\n" +
      "      <p class=\"featured-product__lede\">" + _esc(fpDesc) + "</p>\n" +
      "      <p class=\"featured-product__price\">" + _esc(featuredProduct.price) + "</p>\n" +
      "      <a class=\"btn-primary\" href=\"/products/" + _esc(featuredProduct.slug) + "\">View product <span aria-hidden=\"true\">→</span></a>\n" +
      "    </div>\n" +
      "  </div>\n" +
      "</section>";
  }

  var hero = _render(HOME_HERO, { product_count: heroProductCount })
    .replace("RAW_FEATURED_CALLOUT", featuredHtml);
  // The hero + value band + catalog section give the home page a
  // designed surface even when no products are loaded yet —
  // visitors land on the storefront shell, not a tech demo.
  var body = hero + catalog;
  return _wrap({
    title:      title,
    shop_name:  shopName,
    cart_count: cartCount,
    theme_css: opts.theme_css,
    body:       body,
  });
}

// ---- search results -----------------------------------------------------

var SEARCH_HEADER =
  "<section class=\"search-page\">\n" +
  "  <header class=\"section-head section-head--with-link\">\n" +
  "    <div>\n" +
  "      <p class=\"eyebrow\">Search results</p>\n" +
  "      <h1 class=\"section-head__title\">{{title}}</h1>\n" +
  "      <p class=\"section-head__lede\">{{summary}}</p>\n" +
  "    </div>\n" +
  "    <a class=\"link-arrow\" href=\"/\">All products <span aria-hidden=\"true\">→</span></a>\n" +
  "  </header>\n" +
  "</section>\n";

var SEARCH_EMPTY =
  "<section class=\"search-empty\">\n" +
  "  <div class=\"search-empty__inner\">\n" +
  "    <p class=\"search-empty__icon\" aria-hidden=\"true\">⌕</p>\n" +
  "    <h2>{{heading}}</h2>\n" +
  "    <p>{{copy}}</p>\n" +
  "    <a href=\"/\" class=\"btn-ghost\">Browse the full catalog</a>\n" +
  "  </div>\n" +
  "</section>\n";

function renderSearch(opts) {
  if (!opts || typeof opts.q !== "string") throw new TypeError("storefront.renderSearch: opts.q (string) required");
  var products = Array.isArray(opts.products) ? opts.products : [];
  var qTrim = opts.q.trim();
  var title, summary, emptyHeading, emptyCopy;
  if (qTrim.length === 0) {
    title        = "Search the catalog";
    summary      = "Use the search box in the header to look for a product by title, SKU, or description.";
    emptyHeading = "What are you looking for?";
    emptyCopy    = "Type a query in the header search to find products by title, SKU, or description.";
  } else if (products.length === 0) {
    title        = "No matches";
    summary      = "Nothing in the catalog matched “" + qTrim + "”.";
    emptyHeading = "We don't carry that yet";
    emptyCopy    = "Try a broader term, or browse every product on the home page.";
  } else {
    title   = "“" + qTrim + "”";
    summary = "Showing " + products.length + " match" + (products.length === 1 ? "" : "es") + " for your query.";
  }
  var header = _render(SEARCH_HEADER, { title: title, summary: summary });
  var body;
  if (products.length === 0) {
    body = header + _render(SEARCH_EMPTY, { heading: emptyHeading, copy: emptyCopy });
  } else {
    var assetPrefix = opts.asset_prefix || "/assets/";
    var cards = products.map(function (p) {
      var priceStr = p.starting_price_minor != null
        ? pricing.format(p.starting_price_minor, p.starting_price_currency || "USD")
        : "—";
      var imageUrl = p.hero_media ? assetPrefix + p.hero_media.r2_key : null;
      var imageAlt = p.hero_media ? (p.hero_media.alt_text || p.title) : null;
      return _buildProductCard({ title: p.title, price: priceStr, slug: p.slug, image_url: imageUrl, image_alt: imageAlt });
    }).join("\n");
    body = header + "<section class=\"search-grid\"><div class=\"grid\">" + cards + "</div></section>";
  }
  return _wrap({
    title:      "Search",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    search_q:   opts.q,
    theme_css: opts.theme_css,
    body:       body,
  });
}

// ---- product detail -----------------------------------------------------

// Cart-add form. CSRF defense rests on the `shop_sid` session
// cookie's SameSite=Lax attribute — a cross-site form POST won't
// carry the cookie, so any cross-site "add to cart" lands in a
// fresh anonymous session that the victim never sees. Token-based
// CSRF as defense-in-depth is added alongside the Stripe Elements
// payment route in the next patch.
var VARIANT_ROW =
  "<tr>\n" +
  "  <td class=\"variant-row__title\">{{title}}</td>\n" +
  "  <td class=\"variant-row__sku\"><code>{{sku}}</code></td>\n" +
  "  <td class=\"variant-row__price price\">{{price}}</td>\n" +
  "  <td class=\"variant-row__action\">\n" +
  "    <form method=\"post\" action=\"/cart/lines\">\n" +
  "      <input type=\"hidden\" name=\"variant_id\" value=\"{{variant_id}}\">\n" +
  "      <input type=\"number\" name=\"qty\" value=\"1\" min=\"1\" max=\"99\" class=\"variant-row__qty\" aria-label=\"Quantity\">\n" +
  "      <button type=\"submit\" class=\"btn-primary btn-primary--sm\">Add to cart</button>\n" +
  "    </form>\n" +
  "  </td>\n" +
  "</tr>\n";

var PRODUCT_PAGE =
  "<section class=\"pdp\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\">\n" +
  "    <ol>\n" +
  "      <li><a href=\"/\">Shop</a></li>\n" +
  "      <li aria-current=\"page\">{{title}}</li>\n" +
  "    </ol>\n" +
  "  </nav>\n" +
  "  <div class=\"pdp__grid\">\n" +
  "    <div class=\"pdp__gallery\">RAW_GALLERY_PLACEHOLDER</div>\n" +
  "    <div class=\"pdp__info\">\n" +
  "      <p class=\"eyebrow\">Catalog product</p>\n" +
  "      <h1 class=\"pdp__title\">{{title}}</h1>\n" +
  "      <p class=\"pdp__description\">{{description}}</p>\n" +
  "      <div class=\"pdp__meta\">\n" +
  "        <span class=\"pdp__badge pdp__badge--ok\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> In stock</span>\n" +
  "        <span class=\"pdp__badge\">Ships from origin</span>\n" +
  "        <span class=\"pdp__badge\">Stripe-secured checkout</span>\n" +
  "      </div>\n" +
  "      <div class=\"pdp__variants\">\n" +
  "        <h2 class=\"pdp__variants-title\">Choose a variant</h2>\n" +
  "        <div class=\"table-scroll\">\n" +
  "          <table class=\"variant-table\">\n" +
  "            <thead><tr><th>Variant</th><th>SKU</th><th>Price</th><th class=\"variant-table__action-h\">Action</th></tr></thead>\n" +
  "            <tbody>{{variant_rows}}</tbody>\n" +
  "          </table>\n" +
  "        </div>\n" +
  "      </div>\n" +
  "      RAW_WISHLIST_PLACEHOLDER\n" +
  "    </div>\n" +
  "  </div>\n" +
  "  RAW_REVIEWS_PLACEHOLDER\n" +
  "</section>\n";

// PDP gallery markup — composed once per render call from the
// product's media rows. When media is present, the first row drives
// the main figure (with `alt_text` for a11y) and up to three more
// rows feed the thumbnail strip below it. When media is absent the
// gallery falls back to the existing letter-mark placeholder so a
// freshly-seeded product never renders an empty square.
function _buildPdpGallery(product, media, assetPrefix) {
  var prefix = assetPrefix || "/assets/";
  function _escAttr(s) { return b.template.escapeHtml(s); }
  if (!media || media.length === 0) {
    var initial = (product.title || "?").trim().charAt(0).toUpperCase() || "?";
    return "<figure class=\"pdp__media\" aria-hidden=\"true\">" +
             "<span class=\"pdp__media-mark\">" + _escAttr(initial) + "</span>" +
           "</figure>" +
           "<ul class=\"pdp__thumbs\" aria-hidden=\"true\">" +
             "<li class=\"is-active\"></li><li></li><li></li><li></li>" +
           "</ul>";
  }
  var hero = media[0];
  var heroUrl = prefix + hero.r2_key;
  var heroAlt = hero.alt_text || product.title || "Product image";
  var heroImg = "<figure class=\"pdp__media pdp__media--image\">" +
                  "<img src=\"" + _escAttr(heroUrl) + "\" alt=\"" + _escAttr(heroAlt) + "\" loading=\"eager\">" +
                "</figure>";
  // Thumbnail strip — up to four slots, the active one is the hero.
  // Real thumbnails come from additional media rows; missing slots
  // render as dashed placeholders so the strip's grid doesn't
  // collapse on a single-image product.
  var thumbs = ["<li class=\"is-active\">" +
                  "<img src=\"" + _escAttr(heroUrl) + "\" alt=\"\">" +
                "</li>"];
  for (var i = 1; i < Math.min(media.length, 4); i += 1) {
    var t = media[i];
    var tUrl = prefix + t.r2_key;
    thumbs.push("<li><img src=\"" + _escAttr(tUrl) + "\" alt=\"\"></li>");
  }
  while (thumbs.length < 4) thumbs.push("<li></li>");
  return heroImg + "<ul class=\"pdp__thumbs\" aria-hidden=\"true\">" + thumbs.join("") + "</ul>";
}

// Accessible star glyph row — the precise figure rides in a visually-
// hidden label so a screen reader announces "4.3 out of 5 stars" while
// sighted users see the rounded glyph fill. Mirrors the edge renderer
// (`worker/render/product.js`) so both paths emit identical markup.
function _reviewStars(value, label) {
  var esc = b.template.escapeHtml;
  var filled = Math.round(value);
  if (filled < 0) filled = 0;
  if (filled > 5) filled = 5;
  var glyphs = "";
  for (var i = 1; i <= 5; i += 1) {
    glyphs += "<span class=\"star" + (i <= filled ? " star--on" : "") + "\">" +
      (i <= filled ? "★" : "☆") + "</span>";
  }
  return "<span class=\"stars\" aria-hidden=\"true\">" + glyphs + "</span>" +
         "<span class=\"sr-only\">" + esc(label) + "</span>";
}

function _reviewDate(ts) {
  var n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toISOString().slice(0, 10);
}

// Builds the PDP reviews block from the published aggregate + list.
// Renders the "no reviews yet" empty state when the product has none;
// `ctaHtml` is the operator/customer call-to-action (a "Write a review"
// link, or "Sign in to review", resolved by the route). Mirrors the
// edge renderer byte-for-byte so the two render paths stay in sync.
function _buildReviews(summary, reviews, ctaHtml) {
  var esc = b.template.escapeHtml;
  summary = summary || { count: 0, avg_rating: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
  reviews = reviews || [];
  var count = Number(summary.count) || 0;

  var head;
  if (count > 0) {
    var avg = Number(summary.avg_rating) || 0;
    var avgStr = avg.toFixed(1);
    var dist = summary.distribution || {};
    var bars = "";
    for (var s = 5; s >= 1; s -= 1) {
      var n   = Number(dist[s]) || 0;
      var pct = count > 0 ? Math.round((n / count) * 100) : 0;
      bars +=
        "<li class=\"rating-bar\">" +
          "<span class=\"rating-bar__label\">" + s + " star</span>" +
          "<span class=\"rating-bar__track\"><span class=\"rating-bar__fill\" style=\"width:" + pct + "%\"></span></span>" +
          "<span class=\"rating-bar__count\">" + n + "</span>" +
        "</li>";
    }
    head =
      "<div class=\"reviews__summary\">" +
        "<div class=\"reviews__average\">" +
          "<span class=\"reviews__average-num\">" + esc(avgStr) + "</span>" +
          _reviewStars(avg, avgStr + " out of 5 stars") +
          "<span class=\"reviews__count\">" + count + (count === 1 ? " review" : " reviews") + "</span>" +
        "</div>" +
        "<ul class=\"reviews__distribution\">" + bars + "</ul>" +
      "</div>";
  } else {
    head = "<p class=\"reviews__empty\">No reviews yet. Be the first to review this product.</p>";
  }

  var list = "";
  for (var i = 0; i < reviews.length; i += 1) {
    var r = reviews[i];
    var rating = Number(r.rating) || 0;
    var verified = Number(r.verified_purchase) === 1
      ? "<span class=\"review__verified\">Verified buyer</span>"
      : "";
    var date = _reviewDate(r.created_at);
    var bodyHtml = r.body
      ? "<p class=\"review__body\">" + esc(String(r.body)) + "</p>"
      : "";
    list +=
      "<li class=\"review\">" +
        "<div class=\"review__head\">" +
          _reviewStars(rating, rating + " out of 5 stars") +
          "<h3 class=\"review__title\">" + esc(String(r.title || "")) + "</h3>" +
        "</div>" +
        "<div class=\"review__meta\">" + verified +
          (date ? "<time class=\"review__date\" datetime=\"" + esc(date) + "\">" + esc(date) + "</time>" : "") +
        "</div>" +
        bodyHtml +
      "</li>";
  }
  var listHtml = list ? "<ul class=\"reviews__list\">" + list + "</ul>" : "";

  return "<section class=\"reviews\" aria-labelledby=\"reviews-title\">" +
           "<h2 id=\"reviews-title\" class=\"reviews__heading\">Customer reviews</h2>" +
           head +
           listHtml +
           (ctaHtml || "") +
         "</section>";
}

var REVIEW_FORM_PAGE =
  "<section class=\"review-form-page\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\">\n" +
  "    <ol>\n" +
  "      <li><a href=\"/\">Shop</a></li>\n" +
  "      <li><a href=\"/products/{{slug}}\">{{title}}</a></li>\n" +
  "      <li aria-current=\"page\">Write a review</li>\n" +
  "    </ol>\n" +
  "  </nav>\n" +
  "  <h1 class=\"review-form-page__title\">Review {{title}}</h1>\n" +
  "  RAW_NOTICE_PLACEHOLDER\n" +
  "  <form class=\"review-form\" method=\"post\" action=\"/products/{{slug}}/review\">\n" +
  "    <fieldset class=\"review-form__rating\">\n" +
  "      <legend>Your rating</legend>\n" +
  "      RAW_STARS_PLACEHOLDER\n" +
  "    </fieldset>\n" +
  "    <label class=\"form-field\">\n" +
  "      <span class=\"form-field__label\">Title</span>\n" +
  "      <input type=\"text\" name=\"title\" maxlength=\"120\" required autocomplete=\"off\">\n" +
  "    </label>\n" +
  "    <label class=\"form-field\">\n" +
  "      <span class=\"form-field__label\">Your review</span>\n" +
  "      <textarea name=\"body\" maxlength=\"4000\" rows=\"6\"></textarea>\n" +
  "    </label>\n" +
  "    <button type=\"submit\" class=\"btn-primary\">Submit review</button>\n" +
  "  </form>\n" +
  "</section>\n";

// Auth-gated review form. `opts.product` carries { title, slug };
// `opts.notice` is an optional error string rendered above the form
// (e.g. a validation rejection bounced back from POST).
function renderReviewForm(opts) {
  var esc = b.template.escapeHtml;
  var slug = opts.product.slug;
  var stars = "";
  for (var rv = 5; rv >= 1; rv -= 1) {
    stars +=
      "<label class=\"star-radio\">" +
        "<input type=\"radio\" name=\"rating\" value=\"" + rv + "\" required>" +
        "<span>" + rv + (rv === 1 ? " star" : " stars") + "</span>" +
      "</label>";
  }
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var body = _render(REVIEW_FORM_PAGE, {
    title: opts.product.title,
    slug:  slug,
  })
    .replace("RAW_NOTICE_PLACEHOLDER", notice)
    .replace("RAW_STARS_PLACEHOLDER", stars);
  return _wrap({
    title:      "Review " + opts.product.title,
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Generic single-message page for the review flow (purchase-gate
// refusal, submission thank-you). `cta` is an optional { href, label }.
function _reviewMessagePage(opts, heading, message, cta) {
  var esc = b.template.escapeHtml;
  var ctaHtml = cta
    ? "<a class=\"btn-primary\" href=\"" + esc(cta.href) + "\">" + esc(cta.label) + "</a>"
    : "";
  var body =
    "<section class=\"review-message\">" +
      "<h1 class=\"review-message__title\">" + esc(heading) + "</h1>" +
      "<p class=\"review-message__lede\">" + esc(message) + "</p>" +
      ctaHtml +
    "</section>";
  return _wrap({
    title:      heading,
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Remove control for a wishlist entry — a form POST back through the
// toggle route with `return_to` so the customer lands back on the
// account page (not the product PDP the default toggle returns to).
function _wishlistRemoveForm(productId, esc) {
  return "<form class=\"wishlist-item__remove\" method=\"post\" action=\"/wishlist/toggle\">" +
           "<input type=\"hidden\" name=\"product_id\" value=\"" + esc(productId) + "\">" +
           "<input type=\"hidden\" name=\"return_to\" value=\"/account/wishlist\">" +
           "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Remove</button>" +
         "</form>";
}

// Account "Saved items" page. `opts.items` is a resolved list:
// { product, hero_media } for live products, or { product: null,
// product_id } for entries whose product was archived/deleted (the
// wishlist row is orphan-tolerant by design — render "unavailable",
// never crash the listing).
function renderWishlist(opts) {
  var esc = b.template.escapeHtml;
  var items = opts.items || [];
  var prefix = opts.asset_prefix || "/assets/";
  var rowsHtml = "";
  for (var i = 0; i < items.length; i += 1) {
    var it = items[i];
    if (!it.product) {
      rowsHtml +=
        "<li class=\"wishlist-item wishlist-item--gone\">" +
          "<span class=\"wishlist-item__title\">This item is no longer available.</span>" +
          _wishlistRemoveForm(it.product_id, esc) +
        "</li>";
      continue;
    }
    var slug = esc(it.product.slug);
    var thumb = it.hero_media
      ? "<img src=\"" + esc(prefix + it.hero_media.r2_key) + "\" alt=\"" + esc(it.hero_media.alt_text || it.product.title) + "\" loading=\"lazy\">"
      : "<span class=\"wishlist-item__mark\" aria-hidden=\"true\">" + esc((it.product.title || "?").trim().charAt(0).toUpperCase() || "?") + "</span>";
    rowsHtml +=
      "<li class=\"wishlist-item\">" +
        "<a class=\"wishlist-item__media\" href=\"/products/" + slug + "\">" + thumb + "</a>" +
        "<div class=\"wishlist-item__body\">" +
          "<a class=\"wishlist-item__title\" href=\"/products/" + slug + "\">" + esc(it.product.title) + "</a>" +
          "<a class=\"wishlist-item__view card-link\" href=\"/products/" + slug + "\">View product →</a>" +
        "</div>" +
        _wishlistRemoveForm(it.product.id, esc) +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"wishlist-list\">" + rowsHtml + "</ul>"
    : "<p class=\"wishlist-empty\">You haven't saved anything yet. Browse the shop and tap <strong>Save to wishlist</strong> on products you want to keep an eye on.</p>";
  var body =
    "<section class=\"account-wishlist\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Saved items</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-wishlist__title\">Saved items</h1>" +
      inner +
    "</section>";
  return _wrap({
    title:      "Saved items",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Account "Saved for later" page. `opts.items` is a resolved list:
// { save, product, hero_media } for live products, or { save,
// product: null } when the variant/product behind a saved row was
// archived (orphan-tolerant — render "no longer available").
function renderSaved(opts) {
  var esc = b.template.escapeHtml;
  var items = opts.items || [];
  var prefix = opts.asset_prefix || "/assets/";
  var rowsHtml = "";
  for (var i = 0; i < items.length; i += 1) {
    var it = items[i];
    var save = it.save;
    var moveForm =
      "<form method=\"post\" action=\"/saved/" + esc(save.id) + "/move-to-cart\">" +
        "<button type=\"submit\" class=\"btn-secondary btn-secondary--sm\">Move to cart</button></form>";
    var removeForm =
      "<form method=\"post\" action=\"/saved/" + esc(save.id) + "/remove\">" +
        "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Remove</button></form>";
    if (!it.product) {
      // Archived/unavailable product — only Remove. Move-to-cart can't
      // succeed (no current price / stock), so don't offer it.
      rowsHtml +=
        "<li class=\"saved-item saved-item--gone\">" +
          "<span class=\"saved-item__title\">" + esc(save.sku) + " — no longer available</span>" +
          "<div class=\"saved-item__actions\">" + removeForm + "</div>" +
        "</li>";
      continue;
    }
    var actions = "<div class=\"saved-item__actions\">" + moveForm + removeForm + "</div>";
    var slug = esc(it.product.slug);
    var thumb = it.hero_media
      ? "<img src=\"" + esc(prefix + it.hero_media.r2_key) + "\" alt=\"" + esc(it.hero_media.alt_text || it.product.title) + "\" loading=\"lazy\">"
      : "<span class=\"saved-item__mark\" aria-hidden=\"true\">" + esc((it.product.title || "?").trim().charAt(0).toUpperCase() || "?") + "</span>";
    var priceStr = pricing.format(Number(save.snapshot_price_minor) || 0, "USD");
    rowsHtml +=
      "<li class=\"saved-item\">" +
        "<a class=\"saved-item__media\" href=\"/products/" + slug + "\">" + thumb + "</a>" +
        "<div class=\"saved-item__body\">" +
          "<a class=\"saved-item__title\" href=\"/products/" + slug + "\">" + esc(it.product.title) + "</a>" +
          "<span class=\"saved-item__meta\">Qty " + (Number(save.quantity) || 1) + " &middot; " + esc(priceStr) + " <span class=\"saved-item__snapshot\">(saved price)</span></span>" +
        "</div>" +
        actions +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"saved-list\">" + rowsHtml + "</ul>"
    : "<p class=\"saved-empty\">Nothing saved for later. Use <strong>Save for later</strong> on a cart item to move it here without losing it.</p>";
  var body =
    "<section class=\"account-saved\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Saved for later</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-saved__title\">Saved for later</h1>" +
      inner +
    "</section>";
  return _wrap({
    title:      "Saved for later",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// One labelled text input for the address form. `required` and other
// attrs are passed through; `value` is pre-filled (escaped) for edit.
function _addrField(name, labelText, value, opts) {
  var esc = b.template.escapeHtml;
  opts = opts || {};
  var attrs = "";
  if (opts.required) attrs += " required";
  if (opts.maxlength) attrs += " maxlength=\"" + opts.maxlength + "\"";
  if (opts.pattern) attrs += " pattern=\"" + esc(opts.pattern) + "\"";
  if (opts.autocomplete) attrs += " autocomplete=\"" + esc(opts.autocomplete) + "\"";
  var req = opts.required ? " <span class=\"form-field__req\" aria-hidden=\"true\">*</span>" : "";
  return "<label class=\"form-field\">" +
           "<span class=\"form-field__label\">" + esc(labelText) + req + "</span>" +
           "<input type=\"text\" name=\"" + esc(name) + "\" value=\"" + esc(value == null ? "" : String(value)) + "\"" + attrs + ">" +
         "</label>";
}

// Shared add/edit address form. `addr` pre-fills for edit (null = add).
function _addressForm(action, addr, submitLabel) {
  var esc = b.template.escapeHtml;
  addr = addr || {};
  function _checked(v) { return Number(v) === 1 ? " checked" : ""; }
  return "<form class=\"address-form form-stack\" method=\"post\" action=\"" + esc(action) + "\">" +
    _addrField("recipient_name", "Recipient name", addr.recipient_name, { required: true, maxlength: 120, autocomplete: "name" }) +
    _addrField("label", "Label (e.g. Home, Work)", addr.label, { maxlength: 60 }) +
    _addrField("company", "Company", addr.company, { maxlength: 120, autocomplete: "organization" }) +
    _addrField("street_line1", "Street address", addr.street_line1, { required: true, maxlength: 200, autocomplete: "address-line1" }) +
    _addrField("street_line2", "Apt / suite / unit", addr.street_line2, { maxlength: 200, autocomplete: "address-line2" }) +
    "<div class=\"form-row form-row--inline\">" +
      _addrField("city", "City", addr.city, { required: true, maxlength: 120, autocomplete: "address-level2" }) +
      _addrField("region", "State / region", addr.region, { maxlength: 120, autocomplete: "address-level1" }) +
    "</div>" +
    "<div class=\"form-row form-row--inline\">" +
      _addrField("postal_code", "Postal code", addr.postal_code, { required: true, maxlength: 32, autocomplete: "postal-code" }) +
      _addrField("country", "Country (ISO 3166-1)", addr.country || "US", { required: true, maxlength: 2, pattern: "[A-Za-z]{2}", autocomplete: "country" }) +
    "</div>" +
    _addrField("phone", "Phone", addr.phone, { maxlength: 40, autocomplete: "tel" }) +
    "<label class=\"address-form__check\"><input type=\"checkbox\" name=\"is_default_shipping\" value=\"1\"" + _checked(addr.is_default_shipping) + "> Default shipping address</label>" +
    "<label class=\"address-form__check\"><input type=\"checkbox\" name=\"is_default_billing\" value=\"1\"" + _checked(addr.is_default_billing) + "> Default billing address</label>" +
    "<button type=\"submit\" class=\"btn-primary\">" + esc(submitLabel) + "</button>" +
  "</form>";
}

// Account address book. `opts.addresses` is the customer's non-archived
// rows; `opts.edit` (when set) pre-fills the form for editing that row,
// otherwise the form is a blank "add" form.
function renderAddresses(opts) {
  var esc = b.template.escapeHtml;
  var list = opts.addresses || [];
  var rowsHtml = "";
  for (var i = 0; i < list.length; i += 1) {
    var a = list[i];
    var badges =
      (Number(a.is_default_shipping) === 1 ? "<span class=\"address-card__badge\">Default shipping</span>" : "") +
      (Number(a.is_default_billing) === 1 ? "<span class=\"address-card__badge\">Default billing</span>" : "");
    var lines = [a.recipient_name, a.company, a.street_line1, a.street_line2,
      [a.city, a.region, a.postal_code].filter(Boolean).join(", "), a.country, a.phone]
      .filter(function (x) { return x != null && String(x).length; })
      .map(function (x) { return "<span>" + esc(String(x)) + "</span>"; }).join("");
    rowsHtml +=
      "<li class=\"address-card\">" +
        (a.label ? "<p class=\"address-card__label\">" + esc(a.label) + "</p>" : "") +
        (badges ? "<p class=\"address-card__badges\">" + badges + "</p>" : "") +
        "<address class=\"address-card__body\">" + lines + "</address>" +
        "<div class=\"address-card__actions\">" +
          "<a class=\"btn-ghost btn-ghost--sm\" href=\"/account/addresses/" + esc(a.id) + "/edit\">Edit</a>" +
          (Number(a.is_default_shipping) === 1 ? "" : "<form method=\"post\" action=\"/account/addresses/" + esc(a.id) + "/default-shipping\"><button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Set default shipping</button></form>") +
          (Number(a.is_default_billing) === 1 ? "" : "<form method=\"post\" action=\"/account/addresses/" + esc(a.id) + "/default-billing\"><button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Set default billing</button></form>") +
          "<form method=\"post\" action=\"/account/addresses/" + esc(a.id) + "/archive\"><button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Remove</button></form>" +
        "</div>" +
      "</li>";
  }
  var listHtml = rowsHtml
    ? "<ul class=\"address-list\">" + rowsHtml + "</ul>"
    : "<p class=\"address-empty\">No saved addresses yet. Add one below to speed up checkout.</p>";
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var editing = opts.edit || null;
  var formHeading = editing ? "Edit address" : "Add an address";
  var formAction  = editing ? ("/account/addresses/" + editing.id) : "/account/addresses";
  var body =
    "<section class=\"account-addresses\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Addresses</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-addresses__title\">Addresses</h1>" +
      listHtml +
      "<h2 class=\"account-addresses__form-title\">" + esc(formHeading) + "</h2>" +
      notice +
      _addressForm(formAction, editing, editing ? "Save changes" : "Add address") +
    "</section>";
  return _wrap({
    title:      "Addresses",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Storefront collection index — operator-curated + smart product lists.
function renderCollectionList(opts) {
  var esc = b.template.escapeHtml;
  var cols = opts.collections || [];
  var cardsHtml = "";
  for (var i = 0; i < cols.length; i += 1) {
    var c = cols[i];
    var media = c.hero_image_url
      ? "<figure class=\"collection-index-card__media\"><img src=\"" + esc((opts.asset_prefix || "/assets/") + c.hero_image_url) + "\" alt=\"" + esc(c.title) + "\" loading=\"lazy\"></figure>"
      : "<figure class=\"collection-index-card__media collection-index-card__media--empty\" aria-hidden=\"true\"></figure>";
    cardsHtml +=
      "<a class=\"collection-index-card\" href=\"/collections/" + esc(c.slug) + "\">" +
        media +
        "<div class=\"collection-index-card__meta\">" +
          "<h2 class=\"collection-index-card__title\">" + esc(c.title) + "</h2>" +
          (c.description ? "<p class=\"collection-index-card__desc\">" + esc(c.description) + "</p>" : "") +
        "</div>" +
      "</a>";
  }
  var inner = cardsHtml
    ? "<div class=\"collection-index-grid\">" + cardsHtml + "</div>"
    : "<p class=\"collection-empty\">No collections yet.</p>";
  var body =
    "<section class=\"collection-index\">" +
      "<header class=\"section-head\"><p class=\"eyebrow\">Browse</p>" +
        "<h1 class=\"section-head__title\">Collections</h1></header>" +
      inner +
    "</section>";
  return _wrap({
    title: "Collections", shop_name: opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count, theme_css: opts.theme_css, body: body,
  });
}

// A single collection's page — title + description + product grid. The
// route resolves each member product into the { slug, title, price,
// image_url } shape `_buildProductCard` expects.
function renderCollection(opts) {
  var esc = b.template.escapeHtml;
  var col = opts.collection;
  var products = opts.products || [];
  var cards = products.map(function (p) { return _buildProductCard(p); }).join("");
  var grid = cards
    ? "<div class=\"catalog-grid collection-grid\">" + cards + "</div>"
    : "<p class=\"collection-empty\">No products in this collection yet.</p>";
  var body =
    "<section class=\"collection-page\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/\">Shop</a></li>" +
        "<li><a href=\"/collections\">Collections</a></li>" +
        "<li aria-current=\"page\">" + esc(col.title) + "</li>" +
      "</ol></nav>" +
      "<header class=\"collection-page__head\">" +
        "<h1 class=\"collection-page__title\">" + esc(col.title) + "</h1>" +
        (col.description ? "<p class=\"collection-page__desc\">" + esc(col.description) + "</p>" : "") +
      "</header>" +
      grid +
    "</section>";
  return _wrap({
    title: col.title, shop_name: opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count, theme_css: opts.theme_css, body: body,
  });
}

// Account "Recently viewed" page — a newest-first grid of products the
// signed-in customer has opened, reusing the standard product card.
// `opts.products` is a resolved [{ slug, title, price, image_url,
// image_alt }] list (archived products are dropped before render, so
// the grid is orphan-tolerant). A "Clear history" control renders only
// when the list is non-empty.
function renderRecentlyViewed(opts) {
  var products = opts.products || [];
  var cards = products.map(function (p) { return _buildProductCard(p); }).join("");
  var grid = cards
    ? "<div class=\"catalog-grid recently-viewed-grid\">" + cards + "</div>"
    : "<p class=\"recently-viewed-empty\">You haven't viewed any products yet. As you browse the shop, the products you open show up here.</p>";
  var clear = cards
    ? "<form class=\"recently-viewed__clear\" method=\"post\" action=\"/account/recently-viewed/clear\">" +
        "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Clear history</button></form>"
    : "";
  var body =
    "<section class=\"account-recently-viewed\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Recently viewed</li>" +
      "</ol></nav>" +
      "<header class=\"account-recently-viewed__head\">" +
        "<h1 class=\"account-recently-viewed__title\">Recently viewed</h1>" +
        clear +
      "</header>" +
      grid +
    "</section>";
  return _wrap({
    title: "Recently viewed", shop_name: opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count, theme_css: opts.theme_css, body: body,
  });
}

var RETURN_REASONS = [
  ["defective", "Defective / doesn't work"],
  ["wrong-item", "Wrong item received"],
  ["not-as-described", "Not as described"],
  ["no-longer-needed", "No longer needed"],
  ["damaged-in-transit", "Damaged in transit"],
  ["other", "Other"],
];

function _returnStatusBadge(status) {
  return "<span class=\"return-status return-status--" + b.template.escapeHtml(String(status)) + "\">" +
    b.template.escapeHtml(String(status)) + "</span>";
}

// Customer-facing return-request form for one order. `opts.order` is the
// order row, `opts.lines` its order_lines. `opts.notice` is an optional
// error bounced back from a failed POST.
function renderReturnForm(opts) {
  var esc = b.template.escapeHtml;
  var order = opts.order;
  var lines = opts.lines || [];
  var lineRows = "";
  for (var i = 0; i < lines.length; i += 1) {
    var l = lines[i];
    lineRows +=
      "<li class=\"return-line\">" +
        "<label class=\"return-line__pick\">" +
          "<input type=\"checkbox\" name=\"return_" + esc(l.id) + "\" value=\"1\">" +
          "<span class=\"return-line__sku\"><code>" + esc(l.sku) + "</code></span>" +
        "</label>" +
        "<label class=\"return-line__qty\">Qty to return " +
          "<input type=\"number\" name=\"qty_" + esc(l.id) + "\" value=\"" + (Number(l.qty) || 1) + "\" min=\"1\" max=\"" + (Number(l.qty) || 1) + "\">" +
          " <span class=\"return-line__of\">of " + (Number(l.qty) || 1) + "</span>" +
        "</label>" +
      "</li>";
  }
  var reasonOpts = RETURN_REASONS.map(function (r) {
    return "<option value=\"" + esc(r[0]) + "\">" + esc(r[1]) + "</option>";
  }).join("");
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var body =
    "<section class=\"return-form-page\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/returns\">Returns</a></li>" +
        "<li aria-current=\"page\">Request a return</li>" +
      "</ol></nav>" +
      "<h1 class=\"return-form-page__title\">Request a return</h1>" +
      "<p class=\"return-form-page__order\">Order <code>" + esc(order.id) + "</code></p>" +
      notice +
      "<form class=\"return-form form-stack\" method=\"post\" action=\"/account/orders/" + esc(order.id) + "/return\">" +
        "<fieldset class=\"return-form__lines\"><legend>Which items?</legend>" +
          "<ul class=\"return-line-list\">" + lineRows + "</ul>" +
        "</fieldset>" +
        "<label class=\"form-field\"><span class=\"form-field__label\">Reason</span>" +
          "<select name=\"reason\" required>" + reasonOpts + "</select></label>" +
        "<label class=\"form-field\"><span class=\"form-field__label\">Notes (optional)</span>" +
          "<textarea name=\"customer_notes\" maxlength=\"2000\" rows=\"4\"></textarea></label>" +
        "<button type=\"submit\" class=\"btn-primary\">Request return</button>" +
      "</form>" +
    "</section>";
  return _wrap({
    title:      "Request a return",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Customer's return-authorization list.
function renderReturns(opts) {
  var esc = b.template.escapeHtml;
  var rmas = opts.rmas || [];
  var rowsHtml = "";
  for (var i = 0; i < rmas.length; i += 1) {
    var r = rmas[i];
    var date = r.created_at ? new Date(Number(r.created_at)).toISOString().slice(0, 10) : "";
    rowsHtml +=
      "<li class=\"return-card\">" +
        "<div class=\"return-card__head\">" +
          "<code class=\"return-card__rma\">" + esc(r.rma_code) + "</code>" +
          _returnStatusBadge(r.status) +
        "</div>" +
        "<p class=\"return-card__meta\">" + esc(String(r.reason || "")) +
          (date ? " &middot; <time datetime=\"" + esc(date) + "\">" + esc(date) + "</time>" : "") +
          (Number(r.refund_amount_minor) > 0 ? " &middot; refund " + esc(pricing.format(Number(r.refund_amount_minor), r.refund_currency || "USD")) : "") +
        "</p>" +
        (r.status === "rejected" && r.rejected_reason ? "<p class=\"return-card__reject\">" + esc(String(r.rejected_reason)) + "</p>" : "") +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"return-list\">" + rowsHtml + "</ul>"
    : "<p class=\"return-empty\">No returns yet. Start one from an order in your account.</p>";
  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Returns</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-returns__title\">Returns</h1>" +
      inner +
    "</section>";
  return _wrap({
    title:      "Returns",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Loyalty transaction-type pill — reuses the `pdp__badge` class the
// theme already styles. The type is one of the ledger's closed enum
// (earn / redeem / expire / adjust / tier-bonus).
function _loyaltyTxBadge(type) {
  var esc = b.template.escapeHtml;
  return "<span class=\"pdp__badge loyalty-tx--" + esc(String(type)) + "\">" + esc(String(type)) + "</span>";
}

// Human label for a reward `kind` + its value payload. Keeps the
// catalog row readable without leaking the raw value_json shape.
function _loyaltyRewardValue(reward) {
  var v = reward.value_json || {};
  if (reward.kind === "discount_percent") return (Number(v.percent) || 0) + "% off";
  if (reward.kind === "discount_amount")  return pricing.format(Number(v.amount_minor) || 0, "USD") + " off";
  if (reward.kind === "free_shipping")    return "Free shipping";
  if (reward.kind === "free_product")     return "Free product";
  return reward.kind;
}

// Earn-rule trigger → customer-facing phrase. Operators see slugs;
// customers see plain language. Unknown triggers fall back to the raw
// trigger so a future enum addition still renders something.
var LOYALTY_TRIGGER_LABELS = {
  per_dollar_spent:         "per $1 spent",
  per_purchase:             "per order",
  per_review:               "per review you write",
  per_referral_redeemed:    "per friend you refer",
  birthday:                 "on your birthday",
  signup_bonus:             "when you sign up",
  first_purchase:           "on your first order",
  abandoned_cart_recovered: "when you complete a saved cart",
};

// The signed-in customer's loyalty surface: balance + tier, how points
// are earned (active earn rules), the reward catalog (redeem control
// when wired), the earn/redeem ledger (paginated), and past
// redemptions. Reuses the account/returns layout classes — no new CSS.
function renderLoyalty(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var bal = opts.balance || { balance: 0, lifetime: 0, tier: "bronze" };
  var ratio = Number(opts.redemption_points_per_usd) || 100;

  var notice = opts.notice
    ? "<p class=\"form-notice" + (opts.notice_kind === "error" ? " form-notice--error" : "") + "\" role=\"alert\">" +
        esc(String(opts.notice)) + "</p>"
    : "";

  // Stats strip — balance / tier / lifetime / spendable value.
  var spendableValue = pricing.format(Math.floor((Number(bal.balance) || 0) * 100 / ratio), "USD");
  var stats =
    "<dl class=\"account-dash__stats\">" +
      "<div><dt>Points balance</dt><dd>" + esc(String(Number(bal.balance) || 0)) + "</dd></div>" +
      "<div><dt>Tier</dt><dd>" + esc(String(bal.tier || "bronze")) + "</dd></div>" +
      "<div><dt>Lifetime points</dt><dd>" + esc(String(Number(bal.lifetime) || 0)) + "</dd></div>" +
      "<div><dt>Worth</dt><dd>" + esc(spendableValue) + "</dd></div>" +
    "</dl>";

  // How points are earned.
  var rules = opts.earn_rules || [];
  var earnInner = "";
  for (var i = 0; i < rules.length; i += 1) {
    var rule = rules[i];
    var label = LOYALTY_TRIGGER_LABELS[rule.trigger] || rule.trigger;
    earnInner +=
      "<li class=\"return-card\"><div class=\"return-card__head\">" +
        "<span>" + esc(String(rule.points_per_unit)) + " points " + esc(label) + "</span>" +
      "</div></li>";
  }
  var earnSection = earnInner
    ? "<h2 class=\"pdp__variants-title\">How you earn points</h2><ul class=\"return-list\">" + earnInner + "</ul>"
    : "<h2 class=\"pdp__variants-title\">How you earn points</h2>" +
      "<p class=\"return-empty\">Earn points on every order — your balance grows as you shop.</p>";

  // Reward catalog + redeem control.
  var rewards = opts.rewards || [];
  var rewardSection = "";
  if (rewards.length) {
    var rewardItems = "";
    for (var r = 0; r < rewards.length; r += 1) {
      var rw = rewards[r];
      var affordable = (Number(bal.balance) || 0) >= Number(rw.point_cost);
      var action;
      if (opts.can_redeem) {
        action = "<form method=\"post\" action=\"/account/loyalty/redeem\">" +
          "<input type=\"hidden\" name=\"reward_slug\" value=\"" + esc(rw.slug) + "\">" +
          "<button type=\"submit\" class=\"btn-primary\"" + (affordable ? "" : " disabled") + ">" +
          (affordable ? "Redeem" : "Not enough points") + "</button></form>";
      } else {
        action = "";
      }
      rewardItems +=
        "<li class=\"return-card\"><div class=\"return-card__head\">" +
          "<span class=\"return-card__rma\">" + esc(rw.title) + "</span>" +
          "<span class=\"pdp__badge\">" + esc(_loyaltyRewardValue(rw)) + "</span>" +
        "</div>" +
        "<p class=\"return-card__meta\">" + esc(String(rw.point_cost)) + " points</p>" +
        action +
        "</li>";
    }
    rewardSection =
      "<h2 class=\"pdp__variants-title\">Redeem your points</h2>" +
      "<ul class=\"return-list\">" + rewardItems + "</ul>";
  }

  // Past redemptions.
  var reds = opts.redemptions || [];
  var redSection = "";
  if (reds.length) {
    var redItems = "";
    for (var d = 0; d < reds.length; d += 1) {
      var red = reds[d];
      var rdate = red.redeemed_at ? new Date(Number(red.redeemed_at)).toISOString().slice(0, 10) : "";
      redItems +=
        "<li class=\"return-card\"><div class=\"return-card__head\">" +
          "<span class=\"return-card__rma\">" + esc(red.reward_slug) + "</span>" +
          "<span class=\"pdp__badge loyalty-tx--" + esc(String(red.status)) + "\">" + esc(String(red.status)) + "</span>" +
        "</div>" +
        "<p class=\"return-card__meta\">" + esc(String(red.points_debited)) + " points" +
          (rdate ? " &middot; <time datetime=\"" + esc(rdate) + "\">" + esc(rdate) + "</time>" : "") +
          (red.coupon_code ? " &middot; code <code>" + esc(red.coupon_code) + "</code>" : "") +
        "</p></li>";
    }
    redSection = "<h2 class=\"pdp__variants-title\">Your redemptions</h2><ul class=\"return-list\">" + redItems + "</ul>";
  }

  // Earn/redeem ledger (paginated).
  var hist = opts.history || [];
  var histInner = "";
  for (var h = 0; h < hist.length; h += 1) {
    var tx = hist[h];
    var tdate = tx.occurred_at ? new Date(Number(tx.occurred_at)).toISOString().slice(0, 10) : "";
    var pts = Number(tx.points) || 0;
    var ptsStr = (pts > 0 ? "+" : "") + pts;
    histInner +=
      "<li class=\"return-card\"><div class=\"return-card__head\">" +
        _loyaltyTxBadge(tx.transaction_type) +
        "<span class=\"return-card__rma\">" + esc(ptsStr) + " points</span>" +
      "</div>" +
      "<p class=\"return-card__meta\">" + esc(String(tx.source || "")) +
        (tdate ? " &middot; <time datetime=\"" + esc(tdate) + "\">" + esc(tdate) + "</time>" : "") +
        (tx.notes ? " &middot; " + esc(String(tx.notes)) : "") +
      "</p></li>";
  }
  var historySection;
  if (histInner) {
    var more = opts.history_next_cursor != null
      ? "<p class=\"loyalty-more\"><a class=\"btn-secondary\" href=\"/account/loyalty?cursor=" +
          esc(String(opts.history_next_cursor)) + "\">Older activity</a></p>"
      : "";
    historySection = "<h2 class=\"pdp__variants-title\">Activity</h2><ul class=\"return-list\">" + histInner + "</ul>" + more;
  } else {
    historySection = "<h2 class=\"pdp__variants-title\">Activity</h2>" +
      "<p class=\"return-empty\">No points activity yet. Place an order to start earning.</p>";
  }

  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Rewards</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-returns__title\">Rewards</h1>" +
      notice +
      stats +
      rewardSection +
      earnSection +
      redSection +
      historySection +
    "</section>";

  return _wrap({
    title:      "Rewards",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Human-readable funnel stage for a referred friend. The referred
// email is stored hash-only, so a row never carries an address — the
// surface shows the stage + dates only.
var REFERRAL_STAGE_LABELS = {
  pending:     "Invited",
  visited:     "Visited",
  "signed-up": "Joined",
  converted:   "Converted",
};

// Initials for a leaderboard row — first letter of each whitespace-
// separated word in the display name, up to two, uppercased. Falls back
// to a neutral glyph when the name is empty / whitespace. NEVER renders
// the full name, the email (which is hash-only anyway), or the customer
// id — the public-ish leaderboard surface exposes rank + initials only.
function _referralInitials(displayName) {
  var s = String(displayName == null ? "" : displayName).trim();
  if (!s) return "–";
  var words = s.split(/\s+/);
  var out = "";
  for (var i = 0; i < words.length && out.length < 2; i += 1) {
    var w = words[i];
    if (w.length) out += w.charAt(0);
  }
  return out.toUpperCase() || "–";
}

// The signed-in customer's referral surface: their personal code +
// shareable link, the friends they've referred (funnel stage + dates,
// no PII), the reward funnel summary, and an in-account top-referrer
// leaderboard (rank + initials only — never names/emails/ids). Reuses
// the account/returns layout classes — no new CSS.
function renderReferrals(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;

  var notice = opts.notice
    ? "<p class=\"form-notice" + (opts.notice_kind === "error" ? " form-notice--error" : "") + "\" role=\"alert\">" +
        esc(String(opts.notice)) + "</p>"
    : "";

  // Code + shareable link. `code`/`link` are null until the customer
  // mints one (the empty state offers a Create-code button).
  var code = opts.code || null;
  var link = opts.link || null;
  var codeSection;
  if (code && link) {
    codeSection =
      "<dl class=\"account-dash__stats\">" +
        "<div><dt>Your referral code</dt><dd><code>" + esc(String(code)) + "</code></dd></div>" +
        "<div><dt>Friends converted</dt><dd>" + esc(String(Number(opts.completed_referrals) || 0)) + "</dd></div>" +
        "<div><dt>Friends joined</dt><dd>" + esc(String(Number(opts.invitations_signed_up) || 0)) + "</dd></div>" +
        "<div><dt>Friends invited</dt><dd>" + esc(String(Number(opts.invitations_total) || 0)) + "</dd></div>" +
      "</dl>" +
      "<h2 class=\"pdp__variants-title\">Share your link</h2>" +
      "<p class=\"return-card__meta\">Share this link with friends. Anyone who signs up through it and places their first order is counted here as your referral.</p>" +
      "<p><a class=\"btn-secondary\" href=\"" + esc(String(link)) + "\">" + esc(String(link)) + "</a></p>";
  } else {
    codeSection =
      "<p class=\"return-empty\">You don't have a referral code yet. Create one to start inviting friends.</p>" +
      "<form method=\"post\" action=\"/account/referrals/code\">" +
        "<div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary\">Create my referral code</button></div>" +
      "</form>";
  }

  // Friends referred — funnel stage + dates, no identity.
  var friends = opts.invitations || [];
  var friendsSection;
  if (friends.length) {
    var items = "";
    for (var i = 0; i < friends.length; i += 1) {
      var f = friends[i];
      var stageLabel = REFERRAL_STAGE_LABELS[f.stage] || f.stage || "Invited";
      var when = f.invited_at ? new Date(Number(f.invited_at)).toISOString().slice(0, 10) : "";
      var converted = f.first_purchase_at
        ? new Date(Number(f.first_purchase_at)).toISOString().slice(0, 10)
        : "";
      items +=
        "<li class=\"return-card\"><div class=\"return-card__head\">" +
          "<span class=\"return-card__rma\">Friend " + esc(String(i + 1)) + "</span>" +
          "<span class=\"pdp__badge referral-stage--" + esc(String(f.stage || "pending")) + "\">" + esc(stageLabel) + "</span>" +
        "</div>" +
        "<p class=\"return-card__meta\">" +
          (when ? "Invited <time datetime=\"" + esc(when) + "\">" + esc(when) + "</time>" : "") +
          (converted ? " &middot; converted <time datetime=\"" + esc(converted) + "\">" + esc(converted) + "</time>" : "") +
        "</p></li>";
    }
    friendsSection = "<h2 class=\"pdp__variants-title\">Friends you've referred</h2><ul class=\"return-list\">" + items + "</ul>";
  } else {
    friendsSection = "<h2 class=\"pdp__variants-title\">Friends you've referred</h2>" +
      "<p class=\"return-empty\">No referrals yet. Share your link above to get started.</p>";
  }

  // In-account leaderboard — rank + initials only. The signed-in
  // customer's own row is marked "You".
  var board = opts.leaderboard || [];
  var boardSection = "";
  if (board.length) {
    var rows = "";
    for (var j = 0; j < board.length; j += 1) {
      var entry = board[j];
      var who = entry.is_you ? "You" : _referralInitials(entry.display_name);
      rows +=
        "<li class=\"return-card\"><div class=\"return-card__head\">" +
          "<span class=\"return-card__rma\">#" + esc(String(j + 1)) + " " + esc(who) + "</span>" +
          "<span class=\"pdp__badge\">" + esc(String(Number(entry.completed_referrals) || 0)) + " referred</span>" +
        "</div></li>";
    }
    boardSection = "<h2 class=\"pdp__variants-title\">Top referrers</h2><ul class=\"return-list\">" + rows + "</ul>";
  }

  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Refer a friend</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-returns__title\">Refer a friend</h1>" +
      notice +
      codeSection +
      friendsSection +
      boardSection +
    "</section>";

  return _wrap({
    title:      "Refer a friend",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Subscription status pill — mirrors `_returnStatusBadge`. The status
// string is one of Stripe's enum values (active, trialing, past_due,
// canceled, …), surfaced as a CSS-classed badge the theme can style.
function _subscriptionStatusBadge(status) {
  return "<span class=\"subscription-status subscription-status--" + b.template.escapeHtml(String(status)) + "\">" +
    b.template.escapeHtml(String(status)) + "</span>";
}

// A subscription is cancelable from the storefront while it's still
// billing — active or trialing, and not already wound down at period
// end. A canceled / past_due / incomplete row shows no Cancel control.
var CANCELABLE_SUB_STATUSES = ["active", "trialing", "past_due"];
function _subscriptionIsCancelable(sub) {
  return CANCELABLE_SUB_STATUSES.indexOf(sub.status) !== -1 && Number(sub.cancel_at_period_end) !== 1;
}

// Customer-facing subscription list. `opts.subscriptions` is an array of
// subscription rows, each optionally carrying a resolved `plan` (joined
// by the route). `opts.can_cancel` is false when the deploy has no
// payment handle wired — the list renders read-only with a note, since
// cancel composes Stripe. Empty state points at the catalog (creation is
// a separate Stripe-subscription-checkout surface, not built here).
function renderAccountSubscriptions(opts) {
  var esc = b.template.escapeHtml;
  var subs = opts.subscriptions || [];
  var canCancel = opts.can_cancel !== false;
  var rowsHtml = "";
  for (var i = 0; i < subs.length; i += 1) {
    var s = subs[i];
    var plan = s.plan || null;
    var planSummary = "";
    if (plan) {
      var every = Number(plan.interval_count) > 1
        ? "every " + Number(plan.interval_count) + " " + esc(String(plan.interval)) + "s"
        : "per " + esc(String(plan.interval));
      // Plans mirror Stripe's lowercase currency; pricing.format wants
      // the uppercase ISO 4217 code. A malformed currency / amount on a
      // row falls back to the interval-only summary rather than throwing
      // out of the renderer.
      var ccy = String(plan.currency || "usd").toUpperCase();
      var priceStr;
      try { priceStr = esc(pricing.format(Number(plan.amount_minor), ccy)) + " "; }
      catch (_e) { priceStr = ""; }
      planSummary = priceStr + every;
    } else {
      planSummary = "Plan unavailable";
    }
    var periodEnd = s.current_period_end
      ? new Date(Number(s.current_period_end)).toISOString().slice(0, 10)
      : "";
    var renewalNote = "";
    if (Number(s.cancel_at_period_end) === 1 && periodEnd) {
      renewalNote = "Ends <time datetime=\"" + esc(periodEnd) + "\">" + esc(periodEnd) + "</time>";
    } else if (periodEnd) {
      renewalNote = "Renews <time datetime=\"" + esc(periodEnd) + "\">" + esc(periodEnd) + "</time>";
    }
    var cancelControl = "";
    if (canCancel && _subscriptionIsCancelable(s)) {
      cancelControl =
        "<form class=\"subscription-card__cancel\" method=\"post\" action=\"/account/subscriptions/" + esc(s.id) + "/cancel\">" +
          "<label class=\"subscription-card__when\">" +
            "<input type=\"checkbox\" name=\"immediate\" value=\"1\"> Cancel immediately (skip the rest of the period)" +
          "</label>" +
          "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Cancel subscription</button>" +
        "</form>";
    }
    rowsHtml +=
      "<li class=\"subscription-card\">" +
        "<div class=\"subscription-card__head\">" +
          "<span class=\"subscription-card__plan\">" + planSummary + "</span>" +
          _subscriptionStatusBadge(s.status) +
        "</div>" +
        (renewalNote ? "<p class=\"subscription-card__meta\">" + renewalNote + "</p>" : "") +
        cancelControl +
      "</li>";
  }
  var note = canCancel
    ? ""
    : "<p class=\"subscription-note\">Cancellation isn't available on this store yet. Contact support to make changes.</p>";
  var inner = rowsHtml
    ? note + "<ul class=\"subscription-list\">" + rowsHtml + "</ul>"
    : "<p class=\"subscription-empty\">You have no active subscriptions.</p>";
  var body =
    "<section class=\"account-subscriptions\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Subscriptions</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-subscriptions__title\">Subscriptions</h1>" +
      (opts.notice ? "<p class=\"form-notice\" role=\"status\">" + esc(String(opts.notice)) + "</p>" : "") +
      inner +
    "</section>";
  return _wrap({
    title:      "Subscriptions",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Product-level "Save to wishlist" control + social-proof count.
// Byte-compatible with the edge renderer (`worker/render/product.js`)
// so both paths emit identical markup. Action-only label — the toggle
// route resolves add/remove server-side against the sealed session.
function _buildWishlist(productId, count) {
  var esc = b.template.escapeHtml;
  var n = Number(count) || 0;
  var countHtml = n > 0
    ? "<span class=\"wishlist__count\">" + n + (n === 1 ? " shopper saved this" : " shoppers saved this") + "</span>"
    : "";
  return "<div class=\"wishlist\">" +
           "<form class=\"wishlist__form\" method=\"post\" action=\"/wishlist/toggle\">" +
             "<input type=\"hidden\" name=\"product_id\" value=\"" + esc(productId) + "\">" +
             "<button type=\"submit\" class=\"btn-secondary wishlist__btn\">" +
               "<span class=\"wishlist__heart\" aria-hidden=\"true\">♡</span> Save to wishlist" +
             "</button>" +
           "</form>" +
           countHtml +
         "</div>";
}

// Schema.org JSON-LD block. JSON.stringify covers the standard escapes;
// the `</` → `<\/` rewrite neutralises any literal `</script>` in a
// value. Mirrors the edge renderer's `jsonLdScript`.
function _jsonLdScript(data) {
  var serialised = JSON.stringify(data).replace(/<\/(?=script>)/gi, "<\\/");
  return "<script type=\"application/ld+json\">" + serialised + "</script>";
}

function renderProduct(opts) {
  if (!opts || !opts.product) throw new TypeError("storefront.renderProduct: opts.product required");
  var variants = opts.variants || [];
  var prices   = opts.prices   || {};   // { variant_id: { currency, amount_minor } }
  var shopName = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  var description = opts.product.description || "";
  var rendered = variants.map(function (v) {
    var price = prices[v.id];
    var priceStr = price ? pricing.format(price.amount_minor, price.currency) : "—";
    var vTitle = v.title || (Object.keys(v.options || {}).map(function (k) { return v.options[k]; }).join(" / ") || "Default");
    return { id: v.id, sku: v.sku, title: vTitle, price: priceStr };
  });
  if (opts.theme) {
    return opts.theme.render("product", {
      title:          opts.product.title,
      shop_name:      shopName,
      cart_count:     cartCount,
      product:        { title: opts.product.title, description: description },
      variants:       rendered,
      has_variants:   rendered.length > 0,
      // Pre-rendered reviews block (internally HTML-escaped) for the
      // theme's `{{{ reviews_html }}}` raw slot. The bundled themes
      // include the slot; a custom theme opts in by adding it.
      reviews_html:   _buildReviews(opts.review_summary, opts.reviews, opts.review_cta),
      wishlist_html:  _buildWishlist(opts.product.id, opts.wishlist_count),
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var rows = rendered.map(function (v) {
    return _render(VARIANT_ROW, { title: v.title, sku: v.sku, price: v.price, variant_id: v.id });
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"4\" class=\"empty\">No variants available.</td></tr>";
  var galleryHtml = _buildPdpGallery(opts.product, opts.media || [], opts.asset_prefix || "/assets/");
  var reviewsHtml = _buildReviews(opts.review_summary, opts.reviews, opts.review_cta);
  var wishlistHtml = _buildWishlist(opts.product.id, opts.wishlist_count);
  var body = _render(PRODUCT_PAGE, {
    title:        opts.product.title,
    description:  description,
    variant_rows: "RAW_ROWS_PLACEHOLDER",
  })
    .replace("RAW_GALLERY_PLACEHOLDER", galleryHtml)
    .replace("RAW_ROWS_PLACEHOLDER", rows)
    .replace("RAW_WISHLIST_PLACEHOLDER", wishlistHtml)
    .replace("RAW_REVIEWS_PLACEHOLDER", reviewsHtml);
  // Product-specific OpenGraph + Twitter Card values so shares
  // unfurl as "Operator Tee — blamejs.shop" with the SVG hero, not
  // the default shop-level description + brand logo.
  var heroMedia = (opts.media && opts.media[0]) || null;
  var ogImage   = heroMedia ? ((opts.asset_prefix || "/assets/") + heroMedia.r2_key) : "/assets/brand/logo.png";

  // Product + AggregateOffer JSON-LD, with AggregateRating folded in
  // when published reviews exist. Kept byte-compatible with the edge
  // renderer so the structured data is identical whichever substrate
  // serves the PDP. AggregateRating is omitted (not null) at zero
  // reviews — Google rejects `reviewCount: 0`.
  var priceList = variants
    .map(function (v) { return prices[v.id] ? prices[v.id].amount_minor : null; })
    .filter(function (n) { return Number.isInteger(n); });
  var jsonLd = null;
  if (priceList.length > 0) {
    var lowMinor = Math.min.apply(null, priceList);
    var hiMinor  = Math.max.apply(null, priceList);
    var currency = (prices[variants[0].id] && prices[variants[0].id].currency) || "USD";
    var divisor  = currency === "JPY" || currency === "KRW" ? 1 : 100;
    var aggregateRating;
    if (opts.review_summary && Number(opts.review_summary.count) > 0) {
      aggregateRating = {
        "@type":       "AggregateRating",
        "ratingValue": (Number(opts.review_summary.avg_rating) || 0).toFixed(1),
        "reviewCount": Number(opts.review_summary.count),
        "bestRating":  5,
        "worstRating": 1,
      };
    }
    jsonLd = _jsonLdScript({
      "@context":        "https://schema.org",
      "@type":           "Product",
      "name":            opts.product.title,
      "description":     description || ("Browse " + opts.product.title + " on " + shopName + "."),
      "image":           heroMedia ? [ogImage] : undefined,
      "sku":             variants[0] && variants[0].sku,
      "aggregateRating": aggregateRating,
      "offers":          {
        "@type":         "AggregateOffer",
        "priceCurrency": currency,
        "lowPrice":      (lowMinor / divisor).toFixed(divisor === 1 ? 0 : 2),
        "highPrice":     (hiMinor  / divisor).toFixed(divisor === 1 ? 0 : 2),
        "offerCount":    variants.length,
        "availability":  "https://schema.org/InStock",
      },
    });
  }
  var breadcrumbJsonLd = _jsonLdScript({
    "@context":        "https://schema.org",
    "@type":           "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Shop", "item": "/" },
      { "@type": "ListItem", "position": 2, "name": opts.product.title, "item": "/products/" + opts.product.slug },
    ],
  });
  jsonLd = (jsonLd || "") + breadcrumbJsonLd;

  return _wrap({
    title:          opts.product.title,
    shop_name:      shopName,
    cart_count:     cartCount,
    theme_css:      opts.theme_css,
    og_type:        "product",
    og_title:       opts.product.title + " — " + shopName,
    og_description: description || ("Browse " + opts.product.title + " on " + shopName + "."),
    og_image:       ogImage,
    body:           body + jsonLd,
  });
}

// ---- cart --------------------------------------------------------------

// Read-only line — shown on the order confirmation page. Same
// thumbnail + title + SKU chip pattern as CART_LINE_EDITABLE,
// minus the qty/remove forms. The product cell is still a
// slug-linked anchor so the customer can re-open the PDP from the
// order page.
var CART_LINE =
  "<tr>\n" +
  "  <td class=\"cart-line__product\">\n" +
  "    <a class=\"cart-line__product-link\" href=\"{{product_url}}\">\n" +
  "      RAW_ORDER_LINE_THUMB\n" +
  "      <span class=\"cart-line__product-meta\">\n" +
  "        <span class=\"cart-line__product-title\">{{product_title}}</span>\n" +
  "        <code class=\"cart-line__sku-chip\">{{sku}}</code>\n" +
  "      </span>\n" +
  "    </a>\n" +
  "  </td>\n" +
  "  <td data-label=\"Qty\">{{qty}}</td>\n" +
  "  <td class=\"price\" data-label=\"Unit\">{{unit}}</td>\n" +
  "  <td class=\"price\" data-label=\"Total\">{{total}}</td>\n" +
  "</tr>\n";

// Editable cart line — shown on the /cart page. Includes an inline
// qty form (POST /cart/lines/:id/update) and a remove form (POST
// /cart/lines/:id/remove). HTML forms don't natively support
// PATCH/DELETE so the framework routes use POST with verb-suffix
// paths.
// Editable cart line. The first cell carries a small media tile +
// the product title + the SKU code chip below it; without media,
// the tile drops to a dashed-border placeholder so the row's grid
// doesn't collapse. `product_url` is the slug-linked anchor so the
// visitor can re-enter the PDP from the cart without retyping.
var CART_LINE_EDITABLE =
  "<tr>\n" +
  "  <td class=\"cart-line__product\">\n" +
  "    <a class=\"cart-line__product-link\" href=\"{{product_url}}\">\n" +
  "      RAW_CART_LINE_THUMB\n" +
  "      <span class=\"cart-line__product-meta\">\n" +
  "        <span class=\"cart-line__product-title\">{{product_title}}</span>\n" +
  "        <code class=\"cart-line__sku-chip\">{{sku}}</code>\n" +
  "      </span>\n" +
  "    </a>\n" +
  "  </td>\n" +
  "  <td class=\"cart-line__qty\" data-label=\"Qty\">\n" +
  "    <form method=\"post\" action=\"/cart/lines/{{line_id}}/update\" class=\"cart-line__update\">\n" +
  "      <input type=\"number\" name=\"qty\" value=\"{{qty}}\" min=\"1\" max=\"99999\" class=\"cart-line__qty-input\" aria-label=\"Quantity\">\n" +
  "      <button type=\"submit\" class=\"cart-line__btn cart-line__btn--update\">Update</button>\n" +
  "    </form>\n" +
  "  </td>\n" +
  "  <td class=\"price\" data-label=\"Price\">{{unit}}</td>\n" +
  "  <td class=\"price\" data-label=\"Total\">{{total}}</td>\n" +
  "  <td class=\"cart-line__remove-cell\">\n" +
  "    RAW_CART_LINE_SAVE" +
  "    <form method=\"post\" action=\"/cart/lines/{{line_id}}/remove\">\n" +
  "      <button type=\"submit\" class=\"cart-line__btn cart-line__btn--remove\" aria-label=\"Remove line\">Remove</button>\n" +
  "    </form>\n" +
  "  </td>\n" +
  "</tr>\n";

// ---- checkout form + payment page + order confirmation -----------------

var CHECKOUT_PAGE =
  "<section class=\"checkout-page\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Checkout</p>\n" +
  "    <h1 class=\"section-head__title\">Shipping details</h1>\n" +
  "    <p class=\"section-head__lede\">Enter where the order should ship. Payment runs through Stripe on the next step.</p>\n" +
  "  </header>\n" +
  "  <form method=\"post\" action=\"/checkout\" class=\"form-stack\">\n" +
  "    <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Email</span><input type=\"email\" name=\"email\" required autocomplete=\"email\"></label></div>\n" +
  "    <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Full name</span><input type=\"text\" name=\"name\" required autocomplete=\"name\"></label></div>\n" +
  "    <div class=\"form-row form-row--inline\">\n" +
  "      <label class=\"form-field\"><span class=\"form-field__label\">Country (ISO 3166-1)</span><input type=\"text\" name=\"country\" value=\"US\" maxlength=\"2\" pattern=\"[A-Z]{2}\" required autocomplete=\"country\" class=\"form-field__input--xs\"></label>\n" +
  "      <label class=\"form-field\"><span class=\"form-field__label\">State / Region</span><input type=\"text\" name=\"state\" maxlength=\"5\" autocomplete=\"address-level1\" class=\"form-field__input--xs\"></label>\n" +
  "      <label class=\"form-field\"><span class=\"form-field__label\">Postal code</span><input type=\"text\" name=\"postal\" maxlength=\"16\" autocomplete=\"postal-code\" class=\"form-field__input--sm\"></label>\n" +
  "    </div>\n" +
  "    <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Gift card code <span class=\"small\">(optional)</span></span><input type=\"text\" name=\"gift_card_code\" autocomplete=\"off\" placeholder=\"XXXX-XXXX-XXXX-XXXX\" maxlength=\"24\"></label></div>\n" +
  "    <div class=\"checkout-summary\">\n" +
  "      <h3>Order summary</h3>\n" +
  "      <dl>\n" +
  "        <div><dt>Subtotal</dt><dd>{{subtotal}}</dd></div>\n" +
  "        <div class=\"checkout-summary__total\"><dt>Total <span class=\"small\">(plus tax + shipping)</span></dt><dd>{{subtotal}}</dd></div>\n" +
  "      </dl>\n" +
  "    </div>\n" +
  "    <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary\">Continue to payment <span aria-hidden=\"true\">→</span></button></div>\n" +
  "  </form>\n" +
  "</section>\n";

// Redeem-points-at-checkout field — appended to the checkout form for a
// signed-in customer with a spendable balance. The customer types how
// many points to spend; the server caps the credit at the order total
// and at the balance (the `loyalty_redeem_points` field rides the same
// POST as the gift-card code). The max attribute is advisory client-
// side polish; the backend is authoritative.
function _loyaltyCheckoutField(bal, perUsd) {
  var esc = b.template.escapeHtml;
  var points = Number(bal.balance) || 0;
  var ratio = Number(perUsd) || 100;
  // Minor-unit value of the full balance (points / ratio dollars), for
  // the helper line. Floored to a whole point's worth.
  var worth = pricing.format(Math.floor((points * 100) / ratio), "USD");
  return "<div class=\"form-row\"><label class=\"form-field\">" +
    "<span class=\"form-field__label\">Redeem loyalty points <span class=\"small\">(optional)</span></span>" +
    "<input type=\"number\" name=\"loyalty_redeem_points\" min=\"0\" step=\"1\" max=\"" + points + "\" " +
    "inputmode=\"numeric\" autocomplete=\"off\" placeholder=\"0\">" +
    "<span class=\"form-field__req\">You have " + esc(String(points)) + " points (worth " + esc(worth) +
    ") &middot; " + esc(String(ratio)) + " points = $1</span>" +
    "</label></div>";
}

function renderCheckoutForm(opts) {
  if (!opts) throw new TypeError("storefront.renderCheckoutForm: opts required");
  var lines  = opts.lines  || [];
  var totals = opts.totals || { subtotal_minor: 0, currency: "USD" };
  var shopName = opts.shop_name || "blamejs.shop";
  var subtotal = pricing.format(totals.subtotal_minor, totals.currency);
  if (opts.theme) {
    return opts.theme.render("checkout", {
      title:          "Checkout",
      shop_name:      shopName,
      cart_count:     lines.length,
      subtotal:       subtotal,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var body = _render(CHECKOUT_PAGE, { subtotal: subtotal });
  // Signed-in customer with a spendable points balance — surface a
  // redeem-at-checkout field. The block is appended as raw HTML (the
  // balance + value are numbers we control, the conversion ratio is the
  // ledger's own constant) so it slots into the existing form via a
  // small client island that copies the field into the POST. Rendered
  // only when there's a balance to spend; absent that the checkout is
  // unchanged for guests + zero-balance customers.
  if (opts.loyalty_balance && opts.loyalty_balance.balance > 0) {
    body = body.replace(
      "</form>",
      _loyaltyCheckoutField(opts.loyalty_balance, opts.loyalty_points_per_usd) + "</form>",
    );
  }
  // When PayPal is configured, append its button below the card form. The
  // block is built as raw HTML (appended after the strict render) so the SDK
  // script + handlers survive; the client-id is the only interpolation and is
  // attribute-escaped. The PayPal button's createOrder/onApprove drive the
  // /checkout/paypal/create + /capture routes. (Operators must allow
  // www.paypal.com in their CSP script-src/frame-src, as for js.stripe.com.)
  if (opts.paypal_client_id) {
    body += _paypalCheckoutBlock(opts.paypal_client_id, totals.currency);
  }
  return _wrap({
    title:      "Checkout",
    shop_name:  shopName,
    cart_count: lines.length,
    theme_css: opts.theme_css,
    body:       body,
  });
}

// ---- gift-card balance check (customer-facing) -------------------------
//
// A bearer gift-card code is private — the page never confirms whether a
// code "exists". A recognized active card shows its balance; anything else
// (unknown, malformed, expired, voided, redeemed) shows the same generic
// "couldn't find a balance" message so the page is not a code-probing
// oracle. Server-rendered; the result re-renders the same page with the
// outcome inline.
var GIFT_CARD_PAGE =
  "<section class=\"checkout-page\" style=\"max-width:32rem;margin:0 auto;\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Gift cards</p>\n" +
  "    <h1 class=\"section-head__title\">Check a gift card balance</h1>\n" +
  "    <p class=\"section-head__lede\">Enter the code printed on your gift card to see what's left to spend. Apply it at checkout.</p>\n" +
  "  </header>\n" +
  "  RAW_RESULT" +
  "  <form method=\"post\" action=\"/gift-cards/balance\" class=\"form-stack\">\n" +
  "    <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Gift card code</span><input type=\"text\" name=\"code\" autocomplete=\"off\" placeholder=\"XXXX-XXXX-XXXX-XXXX\" maxlength=\"24\" required></label></div>\n" +
  "    <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary\">Check balance</button></div>\n" +
  "  </form>\n" +
  "</section>\n";

function renderGiftCardBalance(opts) {
  opts = opts || {};
  var shopName = opts.shop_name || "blamejs.shop";
  var resultHtml = "";
  if (opts.balance != null) {
    var bal = pricing.format(opts.balance.balance_minor, opts.balance.currency);
    resultHtml =
      "<div class=\"checkout-summary\"><h3>Balance</h3><dl>" +
      "<div class=\"checkout-summary__total\"><dt>Available</dt><dd>" + b.template.escapeHtml(bal) + "</dd></div>" +
      "</dl></div>";
  } else if (opts.not_found) {
    resultHtml =
      "<p class=\"auth-form__message auth-form__message--err\">" +
      "We couldn't find a balance for that code. Check the characters and try again." +
      "</p>";
  }
  if (opts.theme) {
    return opts.theme.render("gift-card-balance", {
      title:          "Gift card balance",
      shop_name:      shopName,
      cart_count:     opts.cart_count == null ? 0 : opts.cart_count,
      result:         resultHtml,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var body = GIFT_CARD_PAGE.replace("RAW_RESULT", resultHtml);
  return _wrap({
    title:      "Gift card balance",
    shop_name:  shopName,
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

function _paypalCheckoutBlock(clientId, currency) {
  var esc = b.template.escapeHtml;
  var cid = esc(String(clientId));
  var cur = esc(String(currency || "USD"));
  return "\n<div class=\"checkout-paypal\" style=\"max-width:32rem;margin:1.5rem auto 0;\">" +
    "<div class=\"pay-card__divider\"><span>or pay with PayPal</span></div>" +
    "<div id=\"paypal-button-container\"></div>" +
    "<p id=\"paypal-error\" class=\"auth-form__message auth-form__message--err\" hidden></p>" +
    "</div>" +
    "<script src=\"https://www.paypal.com/sdk/js?client-id=" + cid + "&currency=" + cur + "&intent=capture\"></script>" +
    "<script>(function(){" +
    "if(!window.paypal){return;}" +
    "var form=document.querySelector('.checkout-page form');" +
    "var errEl=document.getElementById('paypal-error');" +
    "function vals(){var d={};['email','name','country','state','postal'].forEach(function(k){var el=form&&form.elements[k];if(el){d[k]=el.value;}});return d;}" +
    "function showErr(m){if(errEl){errEl.hidden=false;errEl.textContent=m||'PayPal checkout could not be completed.';}}" +
    "paypal.Buttons({" +
    "onClick:function(_d,actions){if(form&&form.reportValidity&&!form.reportValidity()){return actions.reject();}return actions.resolve();}," +
    "createOrder:function(){return fetch('/checkout/paypal/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(vals())}).then(function(r){return r.json();}).then(function(d){if(!d.id){throw new Error(d.error||'create failed');}return d.id;});}," +
    "onApprove:function(data){return fetch('/checkout/paypal/capture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({paypal_order_id:data.orderID})}).then(function(r){return r.json();}).then(function(d){if(d.redirect){window.location.href=d.redirect;}else{showErr(d.error);}});}," +
    "onError:function(){showErr();}" +
    "}).render('#paypal-button-container');" +
    "})();</script>\n";
}

// Stripe Elements payment page — embeds Stripe.js + a minimal
// mount block. The publishable key is operator-supplied (env
// `STRIPE_PUBLISHABLE_KEY` → forwarded into the rendered HTML).
// The client_secret is per-order; never logged, never persisted.
var PAY_PAGE =
  "<section class=\"pay-page\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Secure checkout · Stripe</p>\n" +
  "    <h1 class=\"section-head__title\">Pay {{grand_total}}</h1>\n" +
  "    <p class=\"section-head__lede\">Order <code class=\"inline-code\">{{order_id}}</code> · the Stripe Payment Element is mounted below in a same-origin form.</p>\n" +
  "  </header>\n" +
  "  <div class=\"pay-card\">\n" +
  "    <div id=\"express-checkout\" class=\"pay-card__express\" hidden>\n" +
  "      <div id=\"express-checkout-element\"></div>\n" +
  "      <div class=\"pay-card__divider\"><span>or pay with card</span></div>\n" +
  "    </div>\n" +
  "    <div id=\"payment-element\" class=\"pay-card__element\"></div>\n" +
  "    <button id=\"submit\" type=\"button\" class=\"btn-primary pay-card__submit\">Pay {{grand_total}}</button>\n" +
  "    <p id=\"payment-message\" class=\"pay-card__message\"></p>\n" +
  "  </div>\n" +
  "  <script src=\"https://js.stripe.com/v3/\"></script>\n" +
  "  <script>\n" +
  "    (function () {\n" +
  "      var stripe = Stripe({{pk_json}});\n" +
  "      var elements = stripe.elements({ clientSecret: {{client_secret_json}}, appearance: { theme: \"stripe\" } });\n" +
  "      var returnUrl = window.location.origin + \"/orders/{{order_id}}\";\n" +
  "      var message = document.getElementById(\"payment-message\");\n" +
  "      function confirm() {\n" +
  "        message.textContent = \"Processing...\";\n" +
  "        return stripe.confirmPayment({ elements: elements, confirmParams: { return_url: returnUrl } }).then(function (result) {\n" +
  "          if (result.error) { message.textContent = result.error.message || \"Payment failed.\"; }\n" +
  "        });\n" +
  "      }\n" +
  "      // Express Checkout Element — renders Apple Pay / Google Pay /\n" +
  "      // Link wallet buttons when the device + the shop's registered\n" +
  "      // payment-method domain make them available. It confirms the\n" +
  "      // same PaymentIntent as the card form, so the webhook + order\n" +
  "      // FSM are identical. Hidden until Stripe reports an available\n" +
  "      // wallet so the divider never sits over an empty box.\n" +
  "      var ece = elements.create(\"expressCheckout\");\n" +
  "      ece.on(\"ready\", function (ev) {\n" +
  "        if (ev && ev.availablePaymentMethods) { document.getElementById(\"express-checkout\").hidden = false; }\n" +
  "      });\n" +
  "      ece.on(\"confirm\", function () { confirm(); });\n" +
  "      ece.mount(\"#express-checkout-element\");\n" +
  "      var paymentElement = elements.create(\"payment\");\n" +
  "      paymentElement.mount(\"#payment-element\");\n" +
  "      document.getElementById(\"submit\").addEventListener(\"click\", function () { confirm(); });\n" +
  "    })();\n" +
  "  </script>\n" +
  "</section>\n";

function renderPayPage(opts) {
  if (!opts || !opts.order)              throw new TypeError("storefront.renderPayPage: opts.order required");
  if (!opts.client_secret)               throw new TypeError("storefront.renderPayPage: opts.client_secret required");
  if (!opts.publishable_key)              throw new TypeError("storefront.renderPayPage: opts.publishable_key required");
  var shopName    = opts.shop_name || "blamejs.shop";
  var cartCount   = opts.cart_count == null ? 0 : opts.cart_count;
  var grandTotal  = pricing.format(opts.order.grand_total_minor, opts.order.currency);
  // Stripe.js and client_secret values must be JSON-encoded so the
  // template engine treats them as raw expressions (`{{{ }}}` /
  // post-render replace) rather than HTML-escaping the quotes. The
  // values are otherwise opaque to the renderer — no string
  // concatenation possible at this layer.
  var pkJson      = JSON.stringify(opts.publishable_key);
  var secretJson  = JSON.stringify(opts.client_secret);
  if (opts.theme) {
    return opts.theme.render("pay", {
      title:               "Pay",
      shop_name:           shopName,
      cart_count:          cartCount,
      order_id:            opts.order.id,
      grand_total:         grandTotal,
      pk_json:             pkJson,
      client_secret_json:  secretJson,
      asset_css_main:      opts.theme.assetUrl("css/main.css"),
    });
  }
  var body = _render(PAY_PAGE, {
    order_id:           opts.order.id,
    grand_total:        grandTotal,
    pk_json:            "RAW_PK",
    client_secret_json: "RAW_SECRET",
  }).replace("RAW_PK",     pkJson)
    .replace("RAW_SECRET", secretJson);
  return _wrap({
    title:      "Pay",
    shop_name:  shopName,
    cart_count: cartCount,
    theme_css: opts.theme_css,
    body:       body,
  });
}

var ORDER_PAGE =
  "<section class=\"order-page\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Order confirmed</p>\n" +
  "    <h1 class=\"section-head__title\">Order <code class=\"inline-code\">{{order_id}}</code></h1>\n" +
  "    <p class=\"section-head__lede\">Status: <span class=\"pdp__badge pdp__badge--ok\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> {{status}}</span></p>\n" +
  "  </header>\n" +
  "  <div class=\"order-page__grid\">\n" +
  "    <div class=\"order-page__items\">\n" +
  "      <h2 class=\"pdp__variants-title\">Items</h2>\n" +
  "      <div class=\"table-scroll\">\n" +
  "        <table class=\"cart-table\">\n" +
  "          <thead><tr><th>Product</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>\n" +
  "          <tbody>{{line_rows}}</tbody>\n" +
  "        </table>\n" +
  "      </div>\n" +
  "    </div>\n" +
  "    <aside class=\"order-page__totals\">\n" +
  "      <h2 class=\"pdp__variants-title\">Totals</h2>\n" +
  "      <dl class=\"totals-list\">\n" +
  "        <div><dt>Subtotal</dt><dd>{{subtotal}}</dd></div>\n" +
  "        <div><dt>Tax</dt><dd>{{tax}}</dd></div>\n" +
  "        <div><dt>Shipping</dt><dd>{{shipping}}</dd></div>\n" +
  "        <div class=\"totals-list__grand\"><dt>Total</dt><dd>{{total}}</dd></div>\n" +
  "      </dl>\n" +
  "    </aside>\n" +
  "  </div>\n" +
  "</section>\n";

function renderOrder(opts) {
  if (!opts || !opts.order) throw new TypeError("storefront.renderOrder: opts.order required");
  var o = opts.order;
  var lines = o.lines || [];
  var shopName  = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  var assetPrefix = opts.asset_prefix || "/assets/";
  // Same lookup shape as renderCart — { variant_id: { product, hero_media } }.
  // Route handler bundles it in; missing entries fall through to
  // SKU-as-title with the placeholder tile.
  var lookup = opts.product_lookup || {};
  var rendered = lines.map(function (l) {
    var match = lookup[l.variant_id] || null;
    var prod  = match && match.product;
    var hero  = match && match.hero_media;
    var imageUrl = hero ? assetPrefix + hero.r2_key : null;
    var imageAlt = hero ? (hero.alt_text || (prod && prod.title) || l.sku) : null;
    return {
      sku:            l.sku,
      qty:            String(l.qty),
      unit:           pricing.format(l.unit_amount_minor, l.unit_currency),
      total:          pricing.format(l.line_total_minor || (l.qty * l.unit_amount_minor), l.unit_currency),
      product_title:  (prod && prod.title) || l.sku,
      product_url:    prod ? ("/products/" + prod.slug) : "#",
      image_url:      imageUrl,
      image_alt:      imageAlt,
    };
  });
  var subtotal = pricing.format(o.subtotal_minor,    o.currency);
  var tax      = pricing.format(o.tax_minor,         o.currency);
  var shipping = pricing.format(o.shipping_minor,    o.currency);
  var total    = pricing.format(o.grand_total_minor, o.currency);
  var recs = opts.recommendations || [];
  if (opts.theme) {
    return opts.theme.render("order", {
      title:               "Order " + o.id,
      shop_name:           shopName,
      cart_count:          cartCount,
      order_id:            o.id,
      status:              o.status,
      lines:               rendered,
      has_lines:           rendered.length > 0,
      subtotal:            subtotal,
      tax:                 tax,
      shipping:            shipping,
      total:               total,
      recommendations:     recs,
      has_recommendations: recs.length > 0,
      asset_css_main:      opts.theme.assetUrl("css/main.css"),
    });
  }
  function _orderEsc(s) { return b.template.escapeHtml(s); }
  var rows = rendered.map(function (l) {
    var thumb = l.image_url
      ? "<span class=\"cart-line__thumb\"><img src=\"" + _orderEsc(l.image_url) + "\" alt=\"" + _orderEsc(l.image_alt) + "\" loading=\"lazy\"></span>"
      : "<span class=\"cart-line__thumb cart-line__thumb--empty\" aria-hidden=\"true\"></span>";
    return _render(CART_LINE, {
      sku:            l.sku,
      qty:            l.qty,
      unit:           l.unit,
      total:          l.total,
      product_title:  l.product_title,
      product_url:    l.product_url,
    }).replace("RAW_ORDER_LINE_THUMB", thumb);
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"4\" class=\"empty\">No items.</td></tr>";
  var body = _render(ORDER_PAGE, {
    order_id:  o.id,
    status:    o.status,
    line_rows: "RAW_LINES",
    subtotal:  subtotal,
    tax:       tax,
    shipping:  shipping,
    total:     total,
  }).replace("RAW_LINES", rows);
  // Post-purchase cross-sell rail — reuses the catalog grid + product-card
  // markup (so it inherits the storefront's card styling), rendered only
  // when the picker returned something.
  var railHtml = "";
  if (recs.length) {
    var railCards = recs.map(function (p) { return _buildProductCard(p); }).join("");
    railHtml =
      "<section class=\"catalog-section order-recommendations\">" +
        "<header class=\"section-head\"><h2 class=\"section-head__title\">Customers also bought</h2></header>" +
        "<div class=\"grid\">" + railCards + "</div>" +
      "</section>";
  }
  return _wrap({
    title:      "Order " + o.id,
    shop_name:  shopName,
    cart_count: cartCount,
    theme_css: opts.theme_css,
    body:       body + railHtml,
  });
}

var CART_PAGE =
  "<section class=\"cart-page\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\">\n" +
  "    <ol>\n" +
  "      <li><a href=\"/\">Shop</a></li>\n" +
  "      <li aria-current=\"page\">Cart</li>\n" +
  "    </ol>\n" +
  "  </nav>\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Your cart</p>\n" +
  "    <h1 class=\"section-head__title\">Review your items</h1>\n" +
  "  </header>\n" +
  "  <div class=\"cart-page__grid\">\n" +
  "    <div class=\"cart-page__items\">\n" +
  "      <div class=\"table-scroll\">\n" +
  "        <table class=\"cart-table\">\n" +
  "          <thead><tr><th>Product</th><th>Quantity</th><th>Unit</th><th>Total</th><th class=\"variant-table__action-h\">Action</th></tr></thead>\n" +
  "          <tbody>{{line_rows}}</tbody>\n" +
  "        </table>\n" +
  "      </div>\n" +
  "    </div>\n" +
  "    <aside class=\"cart-page__summary\">\n" +
  "      <h2 class=\"pdp__variants-title\">Order summary</h2>\n" +
  "      <dl class=\"totals-list\">\n" +
  "        <div><dt>Subtotal</dt><dd>{{subtotal}}</dd></div>\n" +
  "        <div class=\"totals-list__grand\"><dt>Total</dt><dd>{{total}}</dd></div>\n" +
  "      </dl>\n" +
  "      <a href=\"/checkout\" class=\"btn-primary cart-page__checkout\">Continue to checkout <span aria-hidden=\"true\">→</span></a>\n" +
  "      <p class=\"cart-page__note\">Tax and shipping are calculated on the next step. Payment runs through Stripe.</p>\n" +
  "    </aside>\n" +
  "  </div>\n" +
  "</section>\n";

var CART_EMPTY_PAGE =
  "<section class=\"cart-page cart-page--empty\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\">\n" +
  "    <ol>\n" +
  "      <li><a href=\"/\">Shop</a></li>\n" +
  "      <li aria-current=\"page\">Cart</li>\n" +
  "    </ol>\n" +
  "  </nav>\n" +
  "  <div class=\"cart-empty\">\n" +
  "    <div class=\"cart-empty__card\">\n" +
  "      <p class=\"cart-empty__icon\" aria-hidden=\"true\">🛒</p>\n" +
  "      <p class=\"eyebrow cart-empty__eyebrow\">Cart</p>\n" +
  "      <h1 class=\"cart-empty__title\">Your cart is empty</h1>\n" +
  "      <p class=\"cart-empty__lede\">Browse the catalog and the products you add show up here. Items hold their price at add-time, not at checkout.</p>\n" +
  "      <div class=\"cart-empty__cta\">\n" +
  "        <a href=\"/\" class=\"btn-primary\">Browse products <span aria-hidden=\"true\">→</span></a>\n" +
  "        <a href=\"#site-search-q\" class=\"btn-ghost\">Find a specific product</a>\n" +
  "      </div>\n" +
  "    </div>\n" +
  "  </div>\n" +
  "</section>\n";

function renderCart(opts) {
  if (!opts) throw new TypeError("storefront.renderCart: opts required");
  var lines  = opts.lines  || [];
  var totals = opts.totals || { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" };
  var shopName = opts.shop_name || "blamejs.shop";
  var assetPrefix = opts.asset_prefix || "/assets/";
  // `product_lookup` is { variant_id: { product, hero_media } } — the
  // route handler bundles it in. Lines without an entry render with
  // a dashed-placeholder tile + the SKU as the fallback title.
  var lookup  = opts.product_lookup || {};
  var rendered = lines.map(function (l) {
    var match  = lookup[l.variant_id] || null;
    var prod   = match && match.product;
    var hero   = match && match.hero_media;
    var imageUrl = hero ? assetPrefix + hero.r2_key : null;
    var imageAlt = hero ? (hero.alt_text || (prod && prod.title) || l.sku) : null;
    return {
      id:             l.id,
      sku:            l.sku,
      qty:            String(l.qty),
      unit:           pricing.format(l.unit_amount_minor, l.unit_currency),
      total:          pricing.format(l.qty * l.unit_amount_minor, l.unit_currency),
      product_title:  (prod && prod.title) || l.sku,
      product_url:    prod ? ("/products/" + prod.slug) : "#",
      image_url:      imageUrl,
      image_alt:      imageAlt,
    };
  });
  var subtotal = pricing.format(totals.subtotal_minor,    totals.currency);
  var total    = pricing.format(totals.grand_total_minor, totals.currency);
  if (opts.theme) {
    return opts.theme.render("cart", {
      title:          "Cart",
      shop_name:      shopName,
      cart_count:     lines.length,
      lines:          rendered,
      has_lines:      rendered.length > 0,
      subtotal:       subtotal,
      total:          total,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  function _escAttr(s) { return b.template.escapeHtml(s); }
  var body;
  if (rendered.length === 0) {
    body = CART_EMPTY_PAGE;
  } else {
    var canSave = !!opts.can_save;
    var rows = rendered.map(function (l) {
      var thumb = l.image_url
        ? "<span class=\"cart-line__thumb\"><img src=\"" + _escAttr(l.image_url) + "\" alt=\"" + _escAttr(l.image_alt) + "\" loading=\"lazy\"></span>"
        : "<span class=\"cart-line__thumb cart-line__thumb--empty\" aria-hidden=\"true\"></span>";
      // "Save for later" moves the line into the customer's saved list.
      // Rendered only when the feature is wired (and account auth is
      // present); the route itself enforces login, redirecting a guest
      // to sign in.
      var saveBtn = canSave
        ? "<form method=\"post\" action=\"/cart/lines/" + _escAttr(l.id) + "/save\"><button type=\"submit\" class=\"cart-line__btn cart-line__btn--save\">Save for later</button></form>"
        : "";
      return _render(CART_LINE_EDITABLE, {
        sku:            l.sku,
        qty:            l.qty,
        unit:           l.unit,
        total:          l.total,
        line_id:        l.id,
        product_title:  l.product_title,
        product_url:    l.product_url,
      }).replace("RAW_CART_LINE_THUMB", thumb).replace("RAW_CART_LINE_SAVE", saveBtn);
    }).join("");
    body = _render(CART_PAGE, {
      line_rows: "RAW_LINES",
      subtotal:  subtotal,
      total:     total,
    }).replace("RAW_LINES", rows);
  }
  return _wrap({
    title:      "Cart",
    shop_name:  shopName,
    cart_count: lines.length,
    theme_css: opts.theme_css,
    body:       body,
  });
}

// ---- admin landing (HTML — the rest of /admin/* is JSON API) ----------

function renderAdminLanding(opts) {
  opts = opts || {};
  var body =
    "<section class=\"admin-landing\">" +
      "<header class=\"section-head\">" +
        "<p class=\"eyebrow\">Admin API</p>" +
        "<h1 class=\"section-head__title\">There's no admin GUI — operators talk to the framework over HTTP.</h1>" +
        "<p class=\"section-head__lede\">Every admin verb (create / update / archive / refund / restock) is a bearer-token-gated JSON endpoint under <code class=\"inline-code\">/admin/*</code>. Pair it with curl, an API client, or any internal ops console.</p>" +
      "</header>" +
      "<div class=\"admin-landing__grid\">" +
        "<article class=\"admin-card\">" +
          "<p class=\"admin-card__verb\">POST</p>" +
          "<h2>Create a product</h2>" +
          "<pre class=\"admin-card__code\"><code>curl -X POST $SHOP/admin/products \\\n  -H \"authorization: Bearer $ADMIN_API_KEY\" \\\n  -d '{ \"title\": \"Widget\", \"slug\": \"widget\" }'</code></pre>" +
        "</article>" +
        "<article class=\"admin-card\">" +
          "<p class=\"admin-card__verb\">GET</p>" +
          "<h2>Search products</h2>" +
          "<pre class=\"admin-card__code\"><code>curl $SHOP/admin/products/search?q=tee \\\n  -H \"authorization: Bearer $ADMIN_API_KEY\"</code></pre>" +
        "</article>" +
        "<article class=\"admin-card\">" +
          "<p class=\"admin-card__verb\">POST</p>" +
          "<h2>Restock inventory</h2>" +
          "<pre class=\"admin-card__code\"><code>curl -X POST $SHOP/admin/inventory/OPR-TEE-BLK-L/restock \\\n  -H \"authorization: Bearer $ADMIN_API_KEY\" \\\n  -d '{ \"qty\": 25 }'</code></pre>" +
        "</article>" +
        "<article class=\"admin-card\">" +
          "<p class=\"admin-card__verb\">POST</p>" +
          "<h2>Issue a refund</h2>" +
          "<pre class=\"admin-card__code\"><code>curl -X POST $SHOP/admin/orders/$ID/refund \\\n  -H \"authorization: Bearer $ADMIN_API_KEY\" \\\n  -d '{ \"amount_minor\": 3200 }'</code></pre>" +
        "</article>" +
      "</div>" +
      "<aside class=\"admin-landing__note\">" +
        "<p><strong>Why no GUI?</strong> Treating the admin as an API keeps the surface area auditable — every state change lands as a request you can replay, log, and sign. Build the GUI your ops team needs; the framework stays out of the way.</p>" +
        "<p>Endpoint reference: <a href=\"https://github.com/blamejs/blamejs.shop/blob/main/lib/admin.js\" rel=\"noopener\" class=\"link-arrow\">lib/admin.js on GitHub <span aria-hidden=\"true\">→</span></a></p>" +
      "</aside>" +
    "</section>";
  return _wrap({
    title:      "Admin",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// ---- newsletter thank-you ---------------------------------------------

function renderNewsletterThanks(opts) {
  opts = opts || {};
  // Two flavors: `new` (we just enrolled this address) and `dedup`
  // (the address was already on the list). Both render the same
  // shell with copy that tells the visitor what happened, so a
  // double-submit doesn't read as a quiet failure.
  var heading, lede;
  if (opts.status === "dedup") {
    heading = "You're already on the list.";
    lede    = "We had this address from a previous signup. Nothing changed — you'll get release notes the day they ship.";
  } else {
    heading = "You're on the list.";
    lede    = "We'll email you the day there's a new framework release, a security advisory, or a primitive worth knowing about. Nothing else.";
  }
  var body =
    "<section class=\"newsletter-thanks\">" +
      "<div class=\"newsletter-thanks__card\">" +
        "<p class=\"eyebrow\">Newsletter</p>" +
        "<h1 class=\"newsletter-thanks__title\">" + heading + "</h1>" +
        "<p class=\"newsletter-thanks__lede\">" + lede + "</p>" +
        "<div class=\"newsletter-thanks__cta\">" +
          "<a href=\"/\" class=\"btn-primary\">Back to the shop <span aria-hidden=\"true\">→</span></a>" +
          "<a href=\"https://github.com/blamejs/blamejs.shop\" class=\"btn-ghost\" rel=\"noopener\">Star on GitHub</a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Newsletter",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

function renderNewsletterError(opts) {
  opts = opts || {};
  var body =
    "<section class=\"newsletter-thanks\">" +
      "<div class=\"newsletter-thanks__card\">" +
        "<p class=\"eyebrow\">Newsletter</p>" +
        "<h1 class=\"newsletter-thanks__title\">Couldn't enroll that address.</h1>" +
        "<p class=\"newsletter-thanks__lede\">" + (opts.message || "Check the address and try again — only RFC-shape email addresses are accepted.") + "</p>" +
        "<div class=\"newsletter-thanks__cta\">" +
          "<a href=\"/\" class=\"btn-primary\">Back to the shop <span aria-hidden=\"true\">→</span></a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Newsletter",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// ---- 404 ---------------------------------------------------------------

function renderNotFound(opts) {
  opts = opts || {};
  var shopName  = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  if (opts.theme) {
    return opts.theme.render("notfound", {
      title:          "Not found",
      shop_name:      shopName,
      cart_count:     cartCount,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var body =
    "<section class=\"not-found\">" +
      "<div class=\"not-found__inner\">" +
        "<p class=\"not-found__code\">404</p>" +
        "<h1 class=\"not-found__title\">That page slipped the catalog.</h1>" +
        "<p class=\"not-found__lede\">The URL didn't match any route on this storefront. The product might have moved, the slug might have changed, or the link might have been mistyped.</p>" +
        "<div class=\"not-found__cta\">" +
          "<a href=\"/\" class=\"btn-primary\">Back to the shop <span aria-hidden=\"true\">→</span></a>" +
          "<a href=\"/cart\" class=\"btn-ghost\">View your cart</a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Not found",
    shop_name:  shopName,
    cart_count: cartCount,
    theme_css: opts.theme_css,
    body:       body,
  });
}

// ---- route mount -------------------------------------------------------
//
// Caller (server.js) hands us a b.router instance + the data deps.
// We mount the read-only HTML routes. POST routes for cart mutation
// land alongside Stripe Elements wiring in the next patch.

// Session-id cookie binding — carries the cart's session_id across
// requests. Plain HttpOnly + Secure + SameSite=Lax is sufficient here
// because the value (a UUID) is unguessable and grants ZERO authority
// — it's a routing key, not an authentication token. The cart itself
// transitions to `customer_id` on login via cart.setCustomer.
var SESSION_COOKIE_NAME = "shop_sid";

// Authenticated-customer cookie — carries an opaque sealed envelope
// `{ customer_id, exp }`, AEAD-encrypted via b.vault.seal so the
// cookie itself has no internal structure visible to a tampering
// network attacker. Cookie name `shop_auth`; HttpOnly + Secure +
// SameSite=Lax + Path=/. The vault key is the deployment's KEK; a
// rotated vault invalidates every outstanding auth cookie (operator-
// initiated logout-everywhere).
var AUTH_COOKIE_NAME    = "shop_auth";

// WebAuthn ceremony state cookie — short-lived envelope holding the
// random challenge + the ceremony-scoped metadata so register-finish /
// login-finish can verify the same challenge the browser was sent.
// Path-scoped to /account so it never leaks to other routes.
var CHALLENGE_COOKIE_NAME = "shop_auth_chal";

// Short-lived cookie carrying the Stripe PaymentIntent client_secret
// from POST /checkout to GET /pay/:order_id. Path-scoped to /pay/ +
// SameSite=Strict so it's only ever sent to the pay route.
var PAY_COOKIE_NAME = "shop_pay";

// Short-lived sealed cookie holding the in-flight OIDC sign-in state
// (provider + CSRF state + nonce + PKCE verifier) between the redirect
// to the identity provider and the callback. Path-scoped to /account;
// SameSite=Lax so it survives the provider's top-level GET redirect back.
var OAUTH_COOKIE_NAME = "shop_oauth";

// Short-lived sealed cookie naming the referral code an inbound visitor
// arrived through (set by the /r/:code landing). Read at account-creation
// to attribute the new customer to the referrer. Path "/" so it survives
// the visitor's navigation from the landing to the register / sign-in
// flow; SameSite=Lax so a top-level GET from a shared link carries it.
// Sealed so it can't be forged to mis-attribute a signup.
var REFERRAL_COOKIE_NAME = "shop_ref";

// Shape of a valid session id — mirrors cart.js's SESSION_ID_RE.
var SID_SHAPE_RE = /^[A-Za-z0-9_-]{16,64}$/;

// All cookie transport composes the framework's cookie primitive
// (`b.cookies`) — RFC 6265 parse/serialize, prefix invariants, and the
// vault-sealed read/write helpers — rather than hand-built Set-Cookie
// strings and manual header splitting. The jar is memoized; it only
// captures the vault reference (seal/unseal run lazily per call), so
// building it before vault.init() has completed is safe.
var _jar = null;
function _cookieJar() {
  if (!_jar) {
    _jar = b.cookies.create({
      vault:    b.vault,
      defaults: { httpOnly: true, secure: true, sameSite: "Lax", path: "/" },
    });
  }
  return _jar;
}

function _readCookie(req, name) {
  return _cookieJar().read(req, name);
}

function _readSidCookie(req) {
  // A cookie carrying anything but a well-shaped session id (a stale
  // value from an old deploy, a tampered cookie, garbage) reads as "no
  // session" rather than reaching cart.bySession — which throws on a
  // malformed id and would turn every page that renders the cart count
  // into a 500. The cookie grants zero authority, so dropping a
  // malformed one silently is safe.
  var v = _cookieJar().read(req, SESSION_COOKIE_NAME);
  return v && SID_SHAPE_RE.test(v) ? v : null;
}

function _setSidCookie(res, sid) {
  var T = b.constants.TIME;
  _cookieJar().write(res, SESSION_COOKIE_NAME, sid, { expires: new Date(Date.now() + T.days(30)) });
}

// Auth + WebAuthn-challenge cookies carry a vault-sealed JSON envelope.
// writeSealed/readSealed handle the seal + the on-wire prefix; the
// caller works in plain objects.
function _setAuthCookie(res, env) {
  var T = b.constants.TIME;
  _cookieJar().writeSealed(res, AUTH_COOKIE_NAME, JSON.stringify(env), { expires: new Date(Date.now() + T.days(14)) });
}
function _clearAuthCookie(res) {
  _cookieJar().clear(res, AUTH_COOKIE_NAME);
}
function _readAuthEnv(req) {
  var raw = _cookieJar().readSealed(req, AUTH_COOKIE_NAME);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

function _setChallengeCookie(res, env) {
  var T = b.constants.TIME;
  _cookieJar().writeSealed(res, CHALLENGE_COOKIE_NAME, JSON.stringify(env), { expires: new Date(Date.now() + T.minutes(5)), path: "/account" });
}
function _clearChallengeCookie(res) {
  _cookieJar().clear(res, CHALLENGE_COOKIE_NAME, { path: "/account" });
}
function _readChallengeEnv(req) {
  var raw = _cookieJar().readSealed(req, CHALLENGE_COOKIE_NAME);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

// Referral-attribution cookie. Carries the code the visitor arrived
// through + when it was set, sealed so it can't be forged. Path "/" so
// it survives navigation from the landing through register / sign-in.
function _setReferralCookie(res, env) {
  var T = b.constants.TIME;
  _cookieJar().writeSealed(res, REFERRAL_COOKIE_NAME, JSON.stringify(env), { expires: new Date(Date.now() + T.days(30)) });
}
function _clearReferralCookie(res) {
  _cookieJar().clear(res, REFERRAL_COOKIE_NAME);
}
function _readReferralEnv(req) {
  var raw = _cookieJar().readSealed(req, REFERRAL_COOKIE_NAME);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

// ---- account-page renderers --------------------------------------------

var ACCOUNT_LOGIN_PAGE =
  "<section class=\"auth-page\">\n" +
  "  <div class=\"auth-card\">\n" +
  "    <p class=\"eyebrow\">Sign in</p>\n" +
  "    <h1 class=\"auth-card__title\">Welcome back</h1>\n" +
  "    <p class=\"auth-card__lede\">Enter your email and authenticate with your passkey. No password to type, no recovery email to click.</p>\n" +
  "    RAW_LOGIN_ERROR\n" +
  "    <form id=\"login-form\" method=\"post\" class=\"form-stack auth-form\">\n" +
  "      <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Email</span><input type=\"email\" name=\"email\" id=\"email\" required autocomplete=\"email\" autofocus></label></div>\n" +
  "      <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary auth-form__submit\">Sign in with passkey</button></div>\n" +
  "      <p id=\"login-message\" class=\"auth-form__message\"></p>\n" +
  "    </form>\n" +
  "    RAW_LOGIN_OAUTH\n" +
  "    <p class=\"auth-card__alt\">New here? <a href=\"/account/register\">Create an account →</a></p>\n" +
  "  </div>\n" +
  "  RAW_LOGIN_SCRIPT\n" +
  "</section>\n";

var LOGIN_ERROR_MESSAGES = {
  oauth:           "We couldn't complete that sign-in. Please try again.",
  "email-conflict": "That email already has an account — sign in with your passkey instead.",
};

function renderAccountLogin(opts) {
  opts = opts || {};
  var oauthButtons = "";
  if (opts.google_enabled) {
    oauthButtons += "<a class=\"btn-secondary auth-oauth__btn\" href=\"/account/login/google\">Continue with Google</a>";
  }
  if (opts.apple_enabled) {
    oauthButtons += "<a class=\"btn-secondary auth-oauth__btn\" href=\"/account/login/apple\">Continue with Apple</a>";
  }
  var oauthHtml = oauthButtons
    ? "<div class=\"auth-oauth\">" +
        "<div class=\"auth-oauth__divider\"><span>or</span></div>" +
        oauthButtons +
      "</div>"
    : "";
  var errHtml = (opts.error && LOGIN_ERROR_MESSAGES[opts.error])
    ? "<p class=\"auth-form__message auth-form__message--err\">" + b.template.escapeHtml(LOGIN_ERROR_MESSAGES[opts.error]) + "</p>"
    : "";
  var body = ACCOUNT_LOGIN_PAGE
    .replace("RAW_LOGIN_OAUTH", oauthHtml)
    .replace("RAW_LOGIN_ERROR", errHtml)
    .replace("RAW_LOGIN_SCRIPT", _islandScript("passkey-login.js"));
  return _wrap({
    title:      "Sign in",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css: opts.theme_css,
    body:       body,
  });
}

var ACCOUNT_REGISTER_PAGE =
  "<section class=\"auth-page\">\n" +
  "  <div class=\"auth-card\">\n" +
  "    <p class=\"eyebrow\">Create an account</p>\n" +
  "    <h1 class=\"auth-card__title\">Enroll a passkey</h1>\n" +
  "    <p class=\"auth-card__lede\">Accounts use a passkey on your device — no password to remember, no shared secret to phish.</p>\n" +
  "    <form id=\"reg-form\" method=\"post\" class=\"form-stack auth-form\">\n" +
  "      <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Email</span><input type=\"email\" name=\"email\" id=\"email\" required autocomplete=\"email\" autofocus></label></div>\n" +
  "      <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Display name</span><input type=\"text\" name=\"display_name\" id=\"display_name\" maxlength=\"128\" required autocomplete=\"name\"></label></div>\n" +
  "      <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary auth-form__submit\">Create account &amp; enroll passkey</button></div>\n" +
  "      <p id=\"reg-message\" class=\"auth-form__message\"></p>\n" +
  "    </form>\n" +
  "    <p class=\"auth-card__alt\">Already have one? <a href=\"/account/login\">Sign in →</a></p>\n" +
  "  </div>\n" +
  "  RAW_REGISTER_SCRIPT\n" +
  "</section>\n";

function renderAccountRegister(opts) {
  opts = opts || {};
  return _wrap({
    title:      "Create account",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css: opts.theme_css,
    body:       ACCOUNT_REGISTER_PAGE.replace("RAW_REGISTER_SCRIPT", _islandScript("passkey-register.js")),
  });
}

var ACCOUNT_DASH_PAGE =
  "<section class=\"account-dash\">\n" +
  "  <header class=\"account-dash__head\">\n" +
  "    <div>\n" +
  "      <p class=\"eyebrow\">Account</p>\n" +
  "      <h1 class=\"section-head__title\">Hi, {{display_name}}</h1>\n" +
  "      <p class=\"section-head__lede\">Your orders + account controls. Every order ships from origin with a Stripe-secured receipt.</p>\n" +
  "    </div>\n" +
  "    <div class=\"account-dash__actions\">\n" +
  "      <a class=\"btn-secondary\" href=\"/account/wishlist\">Wishlist</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/saved\">Saved for later</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/recently-viewed\">Recently viewed</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/addresses\">Addresses</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/returns\">Returns</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/loyalty\">Rewards</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/referrals\">Refer a friend</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/subscriptions\">Subscriptions</a>\n" +
  "      <form method=\"post\" action=\"/account/logout\"><button type=\"submit\" class=\"btn-ghost\">Sign out</button></form>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "  <dl class=\"account-dash__stats\">\n" +
  "    <div><dt>Orders</dt><dd>{{order_count}}</dd></div>\n" +
  "    <div><dt>Lifetime spend</dt><dd>{{lifetime_spend}}</dd></div>\n" +
  "    <div><dt>Member since</dt><dd>{{member_since}}</dd></div>\n" +
  "    <div><dt>Passkeys</dt><dd>{{passkey_count}}</dd></div>\n" +
  "  </dl>\n" +
  "  <div class=\"account-dash__body\">\n" +
  "    <h2 class=\"pdp__variants-title\">Recent orders</h2>\n" +
  "    <div class=\"table-scroll\">\n" +
  "      <table class=\"account-orders-table\">\n" +
  "        <thead><tr><th>Order</th><th>Items</th><th>Status</th><th>Total</th></tr></thead>\n" +
  "        <tbody>{{order_rows}}</tbody>\n" +
  "      </table>\n" +
  "    </div>\n" +
  "  </div>\n" +
  "</section>\n";

var ACCOUNT_DASH_ORDER_ROW =
  "<tr>\n" +
  "  <td data-label=\"Order\"><a href=\"/orders/{{order_id}}\" class=\"account-order__id\"><code>{{order_id_short}}</code></a></td>\n" +
  "  <td class=\"account-order__items\" data-label=\"Items\">RAW_ACCOUNT_ORDER_THUMBS</td>\n" +
  "  <td data-label=\"Status\"><span class=\"pdp__badge {{status_class}}\">{{status}}</span></td>\n" +
  "  <td class=\"price\" data-label=\"Total\">{{total}}</td>\n" +
  "</tr>\n";

function renderAccount(opts) {
  if (!opts || !opts.customer) throw new TypeError("storefront.renderAccount: opts.customer required");
  var orders = opts.orders || [];
  var assetPrefix = opts.asset_prefix || "/assets/";
  var orderLookup = opts.order_product_lookup || {};   // { order_id: [{ product, hero_media }, ...] }
  var passkeyCount = opts.passkey_count == null ? 0 : opts.passkey_count;

  // Lifetime spend = sum of grand_total_minor across orders, in
  // the dominant currency (defaults to USD; mixed-currency
  // customers are rare in the demo but worth handling — we
  // fallback to "—" when currencies disagree so the stat doesn't
  // silently misrepresent the total).
  var currencies = new Set(orders.map(function (o) { return o.currency || "USD"; }));
  var lifetimeStr = "—";
  if (currencies.size <= 1) {
    var total = orders.reduce(function (acc, o) { return acc + (o.grand_total_minor || 0); }, 0);
    var ccy   = orders.length ? (orders[0].currency || "USD") : "USD";
    lifetimeStr = pricing.format(total, ccy);
  }

  // Member-since — earliest known order date, or "—" if none.
  // The customer row may carry a `created_at` epoch ms; if so
  // prefer that (it's authoritative).
  var memberSince = "—";
  if (opts.customer.created_at) {
    memberSince = new Date(opts.customer.created_at).toISOString().slice(0, 10);
  } else if (orders.length) {
    var earliest = orders.reduce(function (acc, o) {
      var t = o.created_at || Infinity;
      return t < acc ? t : acc;
    }, Infinity);
    if (isFinite(earliest)) memberSince = new Date(earliest).toISOString().slice(0, 10);
  }

  function _statusClass(s) {
    if (s === "completed" || s === "shipped" || s === "delivered") return "pdp__badge--ok";
    return "";
  }
  function _escAttr(s) { return b.template.escapeHtml(s); }

  var rows = orders.map(function (o) {
    var products = orderLookup[o.id] || [];
    var thumbs = products.slice(0, 4).map(function (entry) {
      if (entry && entry.hero_media) {
        return "<span class=\"account-order__thumb\"><img src=\"" + _escAttr(assetPrefix + entry.hero_media.r2_key) + "\" alt=\"" + _escAttr(entry.hero_media.alt_text || (entry.product && entry.product.title) || "") + "\" loading=\"lazy\"></span>";
      }
      return "<span class=\"account-order__thumb account-order__thumb--empty\" aria-hidden=\"true\"></span>";
    }).join("");
    if (!thumbs) thumbs = "<span class=\"account-order__thumb account-order__thumb--empty\" aria-hidden=\"true\"></span>";
    var moreCount = products.length > 4 ? "<span class=\"account-order__more\">+" + (products.length - 4) + "</span>" : "";
    return _render(ACCOUNT_DASH_ORDER_ROW, {
      order_id:       o.id,
      order_id_short: o.id.slice(0, 8),
      status:         o.status,
      status_class:   _statusClass(o.status),
      total:          pricing.format(o.grand_total_minor, o.currency),
    }).replace("RAW_ACCOUNT_ORDER_THUMBS", thumbs + moreCount);
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"4\" class=\"empty\">No orders yet. Browse the shop and your first order shows up here.</td></tr>";
  var body = _render(ACCOUNT_DASH_PAGE, {
    display_name:    opts.customer.display_name,
    order_count:     String(orders.length),
    lifetime_spend:  lifetimeStr,
    member_since:    memberSince,
    passkey_count:   String(passkeyCount),
    order_rows:      "RAW_ORDER_ROWS",
  }).replace("RAW_ORDER_ROWS", rows);
  return _wrap({
    title:      "Account",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css: opts.theme_css,
    body:       body,
  });
}

function mount(router, deps) {
  if (!router || typeof router.get !== "function") throw new TypeError("storefront.mount: router with .get() required");
  if (!deps || !deps.catalog || !deps.cart) throw new TypeError("storefront.mount: deps.catalog + deps.cart required");
  var shopName = (deps.config && deps.config.shop_name) || "blamejs.shop";
  // Optional theme — when supplied, every renderer below dispatches
  // to file-backed templates under <themesDir>/<name>/. When absent,
  // the inline-string templates above stay in force (operators on
  // older deploys keep their current look without a migration step).
  var theme = deps.theme || null;
  // Subscription self-management — opts in /account/subscriptions. The
  // cancel route additionally needs the payment handle (cancel composes
  // Stripe via the primitive); without it the list stays read-only.
  var subscriptions = deps.subscriptions || null;

  function _send(res, status, html) {
    res.status(status);
    res.setHeader && res.setHeader("content-type", "text/html; charset=utf-8");
    res.end ? res.end(html) : res.send(html);
  }

  // Defensive request-shape reader for the optional loyalty-points
  // redeem field on the checkout form. Returns undefined for missing /
  // empty / zero / non-numeric input (checkout treats undefined as "no
  // redemption"); a positive integer otherwise. The backend's
  // _resolveLoyaltyCredit is authoritative on balance + cap — this only
  // shapes the wire value so a blank field doesn't become a "0 points"
  // validation error.
  function _parseRedeemPoints(raw) {
    if (raw == null || raw === "") return undefined;
    var n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n;
  }

  // Cart-count read shared across every handler that wraps a page in
  // the layout — the header's cart pill renders the count. Returns 0
  // for visitors with no session cookie. Defined at the top of mount
  // so the /admin landing + the onNotFound 404 handler (mounted
  // outside the `if (deps.customers)` block below) can reach it.
  async function _cartCountForReq(req) {
    var sid = _readSidCookie(req);
    if (!sid) return 0;
    var c = await deps.cart.bySession(sid);
    if (!c) return 0;
    var lines = await deps.cart.listLines(c.id);
    return lines.length;
  }

  // Absolute shareable referral link for a code. Prefers the operator's
  // configured origin (deps.shop_origin / SHOP_ORIGIN) so the link is
  // stable across the edge/container split; falls back to the request's
  // Host header when no origin is configured (dev / single-host deploys).
  // The /r/<code> landing is container-served (not an edge route), so it
  // always reaches this primitive's attribution handler.
  function _referralLink(req, code) {
    var origin = deps.shop_origin
      ? String(deps.shop_origin).replace(/\/$/, "")
      : null;
    if (!origin) {
      var host = (req && req.headers && (req.headers.host || req.headers.Host)) || "";
      origin = host ? ("https://" + host) : "";
    }
    return origin + "/r/" + encodeURIComponent(code);
  }

  // The signed-in customer's sealed-cookie envelope, or null. Shared by
  // the PDP view recorder (mounted outside the `if (deps.customers)`
  // block) and the account routes inside it, so there's one auth-cookie
  // reader rather than a copy per call site. A missing / malformed /
  // expired cookie returns null — never throws.
  function _currentCustomerEnv(req) {
    var env = _readAuthEnv(req);
    if (!env || !env.customer_id || !env.exp || env.exp < Date.now()) return null;
    return env;
  }

  // Resolve a product id into the { slug, title, price, image_url,
  // image_alt } shape `_buildProductCard` expects. Returns null for an
  // archived / missing product so it drops out of any grid (collections,
  // recently-viewed). Shared so the decoration rule lives in one place.
  var _cardAssetPrefix = deps.asset_prefix || "/assets/";
  async function _decorateProductCard(pid) {
    var product = await deps.catalog.products.get(pid);
    if (!product || product.status !== "active") return null;
    var priceStr = "—";
    var variants = await deps.catalog.variants.listForProduct(pid);
    if (variants.length) {
      var pr = await deps.catalog.prices.current(variants[0].id, "USD");
      if (pr) priceStr = pricing.format(pr.amount_minor, pr.currency);
    }
    var media = await deps.catalog.media.listForProduct(pid);
    var hero = media.length ? media[0] : null;
    return {
      slug:      product.slug,
      title:     product.title,
      price:     priceStr,
      image_url: hero ? (_cardAssetPrefix + hero.r2_key) : null,
      image_alt: hero ? (hero.alt_text || product.title) : null,
    };
  }

  // Resolve the cart for this request — read session_id from the
  // sealed cookie, create one (and the cart) if absent. Returns
  // the cart row OR null when the cart was just created (caller can
  // use { sid, cart: null } to skip lookup).
  async function _getOrCreateCart(req, res, currency) {
    var sid = _readSidCookie(req);
    if (!sid) {
      sid = b.uuid.v7();
      _setSidCookie(res, sid);
    }
    var existing = await deps.cart.bySession(sid);
    if (existing) return { sid: sid, cart: existing };
    var created = await deps.cart.create(sid, { currency: currency || "USD" });
    return { sid: sid, cart: created };
  }

  router.get("/", async function (_req, res) {
    var page = await deps.catalog.products.list({ status: "active", limit: 24 });
    // Best-effort "starting price" + "hero media" lookup. Each
    // product on the home grid carries its first variant's USD
    // price (when one exists) and its first attached media row
    // (when one exists). Both are best-effort — products without
    // a price render `—`; products without media render the
    // text-only PRODUCT_CARD fallback.
    var products = [];
    for (var i = 0; i < page.rows.length; i += 1) {
      var p = page.rows[i];
      var variants = await deps.catalog.variants.listForProduct(p.id);
      var startingPrice = null;
      if (variants.length) {
        var price = await deps.catalog.prices.current(variants[0].id, "USD");
        if (price) startingPrice = price;
      }
      var media = await deps.catalog.media.listForProduct(p.id);
      var heroMedia = media.length ? media[0] : null;
      products.push(Object.assign({}, p, {
        starting_price_minor:    startingPrice ? startingPrice.amount_minor : null,
        starting_price_currency: startingPrice ? startingPrice.currency      : "USD",
        hero_media:              heroMedia,
      }));
    }
    var html = renderHome({ products: products, shop_name: shopName, theme: theme });
    _send(res, 200, html);
  });

  router.get("/search", async function (req, res) {
    var url = req.url ? new URL(req.url, "http://localhost") : null;
    var qRaw = url && url.searchParams.get("q");
    var q = typeof qRaw === "string" ? qRaw : "";
    // Cap at the validator's max length before handing to the
    // primitive — defends against a 10 MiB `?q=...` mass that would
    // otherwise round-trip through the LIKE escape function.
    if (q.length > 200) q = q.slice(0, 200);
    var products = [];
    if (q.trim().length > 0) {
      var page = await deps.catalog.products.search({ q: q, status: "active", limit: 24 });
      for (var i = 0; i < page.rows.length; i += 1) {
        var p = page.rows[i];
        var variants = await deps.catalog.variants.listForProduct(p.id);
        var startingPrice = null;
        if (variants.length) {
          var price = await deps.catalog.prices.current(variants[0].id, "USD");
          if (price) startingPrice = price;
        }
        var media = await deps.catalog.media.listForProduct(p.id);
        var heroMedia = media.length ? media[0] : null;
        products.push(Object.assign({}, p, {
          starting_price_minor:    startingPrice ? startingPrice.amount_minor : null,
          starting_price_currency: startingPrice ? startingPrice.currency      : "USD",
          hero_media:              heroMedia,
        }));
      }
    }
    var sid = _readSidCookie(req);
    var cartCount = 0;
    if (sid) {
      var c = await deps.cart.bySession(sid);
      if (c) {
        var lines = await deps.cart.listLines(c.id);
        cartCount = lines.length;
      }
    }
    _send(res, 200, renderSearch({
      q:          q,
      products:   products,
      shop_name:  shopName,
      cart_count: cartCount,
    }));
  });

  router.get("/products/:slug", async function (req, res) {
    var slug = req.params && req.params.slug;
    if (!slug) return _send(res, 400, renderNotFound({ shop_name: shopName, theme: theme }));
    var product = await deps.catalog.products.bySlug(slug);
    if (!product) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
    var variants = await deps.catalog.variants.listForProduct(product.id);
    var prices = {};
    for (var i = 0; i < variants.length; i += 1) {
      var p = await deps.catalog.prices.current(variants[i].id, "USD");
      if (p) prices[variants[i].id] = p;
    }
    // Media — first row drives the hero image, the next three feed
    // the thumbnail strip. `listForProduct` is product-level only;
    // variant-level media (`listForVariant`) would feed a swap-on-
    // variant-select interaction we don't ship yet.
    var media = await deps.catalog.media.listForProduct(product.id);
    // Render cart count from the current session's cart, if any.
    var sid = _readSidCookie(req);
    var cartCount = 0;
    if (sid) {
      var c = await deps.cart.bySession(sid);
      if (c) {
        var lines = await deps.cart.listLines(c.id);
        cartCount = lines.length;
      }
    }
    // Published reviews aggregate + list. A failed read (e.g. the
    // reviews table not yet migrated) degrades to the empty state
    // rather than 500-ing the whole PDP — reviews are supplementary
    // to the buy path. Mirrors the edge renderer's missing-table
    // resilience.
    var reviewSummary, reviewRows, reviewCta;
    if (deps.reviews) {
      try {
        reviewSummary = await deps.reviews.summaryForProduct(product.id);
        reviewRows    = (await deps.reviews.listForProduct(product.id, { limit: 10 })).rows;
      } catch (_e) { reviewSummary = undefined; reviewRows = []; }
      // The form route enforces auth + the verified-purchase gate, so
      // the CTA links there unconditionally; logged-out shoppers get
      // redirected to login, non-purchasers get a clear "not eligible".
      reviewCta = "<a class=\"btn-secondary reviews__cta\" href=\"/products/" +
        b.template.escapeHtml(product.slug) + "/review\">Write a review</a>";
    }
    // Wishlist social-proof count — degrades to 0 on a read failure
    // (e.g. table not yet migrated) rather than 500-ing the PDP.
    var wishlistCount = 0;
    if (deps.wishlist) {
      try { wishlistCount = await deps.wishlist.countForProduct(product.id); }
      catch (_e) { wishlistCount = 0; }
    }
    // Log the view for a signed-in customer so it surfaces on their
    // "Recently viewed" account page. Drop-silent — a recording failure
    // (table not migrated, write contention) must never break the PDP
    // render. Guests aren't recorded here: their PDP is edge-cached with
    // no per-request container hop, so session-scoped guest history is a
    // separate opt-in (a client beacon) the storefront doesn't ship yet.
    if (deps.recentlyViewed && deps.customers) {
      var rvEnv = _currentCustomerEnv(req);
      if (rvEnv) {
        try { await deps.recentlyViewed.recordView({ customer_id: rvEnv.customer_id, product_id: product.id }); }
        catch (_e) { /* drop-silent — recently-viewed is supplementary to the buy path */ }
      }
    }
    var html = renderProduct({
      product:        product,
      variants:       variants,
      prices:         prices,
      media:          media,
      review_summary: reviewSummary,
      reviews:        reviewRows,
      review_cta:     reviewCta,
      wishlist_count: wishlistCount,
      shop_name:      shopName,
      cart_count:     cartCount,
      theme:          theme,
    });
    _send(res, 200, html);
  });

  // Collections — operator-curated + smart product lists. Public browse
  // pages; mounted when the collections primitive is wired.
  if (deps.collections) {
    router.get("/collections", async function (req, res) {
      var cols = await deps.collections.list({ active_only: true });
      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderCollectionList({
        collections: cols, shop_name: shopName, cart_count: cartCount, asset_prefix: _cardAssetPrefix,
      }));
    });

    router.get("/collections/:slug", async function (req, res) {
      var slug = req.params && req.params.slug;
      // get() and productsIn() both throw on a malformed slug (the
      // primitive validates shape). A bad path segment is a 404, not a
      // 500 — the route is a defensive request-shape reader.
      var col, result;
      try {
        col = slug ? await deps.collections.get(slug) : null;
        if (!col || col.archived_at != null) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        result = await deps.collections.productsIn({ slug: slug, limit: 24 });
      } catch (e) {
        if (e instanceof TypeError) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        throw e;
      }
      var products = [];
      for (var i = 0; i < result.rows.length; i += 1) {
        var pid = result.rows[i].product_id || result.rows[i].id;
        var card = await _decorateProductCard(pid);
        if (card) products.push(card);
      }
      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderCollection({
        collection: col, products: products, shop_name: shopName, cart_count: cartCount,
      }));
    });
  }

  router.get("/cart", async function (req, res) {
    var sid = _readSidCookie(req);
    if (!sid) {
      return _send(res, 200, renderCart({
        lines: [], totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
        shop_name: shopName, theme: theme,
      }));
    }
    var c = await deps.cart.bySession(sid);
    if (!c) {
      return _send(res, 200, renderCart({
        lines: [], totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
        shop_name: shopName, theme: theme,
      }));
    }
    var lines = await deps.cart.listLines(c.id);
    var totals = pricing.totals(c, lines, {});
    // Build the variant_id → { product, hero_media } lookup the
    // renderer uses to decorate each line with a thumbnail + title.
    // Cache by variant_id so a cart with the same variant twice
    // only hits the catalog once.
    var productLookup = {};
    for (var i = 0; i < lines.length; i += 1) {
      var vId = lines[i].variant_id;
      if (productLookup[vId]) continue;
      var v = await deps.catalog.variants.get(vId);
      if (!v) { productLookup[vId] = null; continue; }
      var prod = await deps.catalog.products.get(v.product_id);
      var media = await deps.catalog.media.listForProduct(v.product_id);
      productLookup[vId] = {
        product:    prod,
        hero_media: media.length ? media[0] : null,
      };
    }
    _send(res, 200, renderCart({
      lines:           lines,
      totals:          totals,
      product_lookup:  productLookup,
      can_save:        !!(deps.saveForLater && deps.customers),
      shop_name:       shopName,
      theme:           theme,
    }));
  });

  // ---- checkout flow -------------------------------------------------
  //
  // GET  /checkout         — renders the shipping form
  // POST /checkout         — calls checkout.confirm; redirects to /pay/:order_id
  // GET  /pay/:order_id    — Stripe Elements payment page
  // GET  /orders/:order_id — order confirmation (post-purchase landing)
  //
  // The checkout / payment / order deps are optional in mount(); the
  // routes only register when supplied. This lets the framework boot
  // in pure-storefront mode (catalog + cart only) for stores that
  // are still configuring payment.
  if (deps.checkout && deps.order) {
    router.get("/checkout", async function (req, res) {
      var sid = _readSidCookie(req);
      if (!sid) return _send(res, 303, "<a href=\"/cart\">Cart is empty</a>"), res.setHeader && res.setHeader("location", "/cart");
      var c = await deps.cart.bySession(sid);
      if (!c) {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      var lines = await deps.cart.listLines(c.id);
      if (!lines.length) {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      var totals = pricing.totals(c, lines, {});
      // Loyalty balance — only for a signed-in customer with loyalty
      // wired. A read failure (table not migrated) degrades to no
      // redeem field rather than 500-ing checkout.
      var loyaltyBalance = null;
      if (deps.loyalty) {
        var loyAuth = _currentCustomerEnv(req);
        if (loyAuth) {
          try { loyaltyBalance = await deps.loyalty.balance(loyAuth.customer_id); }
          catch (_e) { loyaltyBalance = null; }
        }
      }
      _send(res, 200, renderCheckoutForm({
        lines: lines, totals: totals, shop_name: shopName, theme: theme,
        paypal_client_id: deps.paypal ? deps.paypal_client_id : null,
        loyalty_balance: loyaltyBalance,
        loyalty_points_per_usd: deps.loyalty ? deps.loyalty.REDEMPTION_POINTS_PER_USD : null,
      }));
    });

    router.post("/checkout", async function (req, res) {
      var body = req.body || {};
      var sid = _readSidCookie(req);
      if (!sid) {
        res.status(400); return res.end ? res.end("No session") : res.send("No session");
      }
      var c = await deps.cart.bySession(sid);
      if (!c) {
        res.status(400); return res.end ? res.end("No cart") : res.send("No cart");
      }
      // Defensive cart-state guard — if the cart has already been
      // converted (e.g. duplicate-submit on POST refresh), redirect
      // to the most recent order for this session.
      if (c.status !== "active") {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      var shipTo = {
        country: (body.country || "").toUpperCase(),
        state:   body.state ? String(body.state).toUpperCase() : undefined,
        postal:  body.postal || undefined,
      };
      try {
        // default_shipping_id may be a literal string or an
        // operator-supplied async resolver (e.g. backed by the
        // config primitive) so re-reads happen per request without
        // a container restart.
        var defaultShipId;
        if (typeof deps.default_shipping_id === "function") {
          defaultShipId = await deps.default_shipping_id();
        } else {
          defaultShipId = deps.default_shipping_id;
        }
        var result = await deps.checkout.confirm({
          cart_id:              c.id,
          ship_to:              shipTo,
          selected_shipping_id: defaultShipId || "std",
          customer:             { email: body.email, name: body.name },
          gift_card_code:       body.gift_card_code || undefined,
          loyalty_redeem_points: _parseRedeemPoints(body.loyalty_redeem_points),
          idempotency_key:      "checkout:" + c.id + ":" + b.uuid.v7(),
        });
        // When a gift card fully covered the order there's no Stripe
        // intent — the order is already paid. Skip the pay-cookie +
        // pay page and land the customer straight on the confirmation.
        if (!result.payment_intent) {
          res.status(303);
          res.setHeader && res.setHeader("location", "/orders/" + result.order.id);
          return res.end ? res.end() : res.send("");
        }
        // Set a short-lived pay cookie so /pay/:order_id can serve the
        // client_secret without re-running confirm. Scoped to /pay/ +
        // SameSite=Strict so it's only ever sent to the pay route.
        _cookieJar().write(res, PAY_COOKIE_NAME, result.payment_intent.client_secret, {
          expires: new Date(Date.now() + b.constants.TIME.minutes(15)), path: "/pay/", sameSite: "Strict",
        });
        res.status(303);
        res.setHeader && res.setHeader("location", "/pay/" + result.order.id);
        return res.end ? res.end() : res.send("");
      } catch (e) {
        // A bad customer input (malformed shape, a gift-card code, or a
        // loyalty-points request the customer entered that can't be
        // applied) is a 400, not a 500 — the gift-card errors carry a
        // GIFTCARD_* code and the loyalty errors a LOYALTY_* code so a
        // fat-fingered value re-prompts rather than 500-ing checkout.
        var code = (e && typeof e.code === "string") ? e.code : "";
        var clientErr = (e instanceof TypeError) || code.indexOf("GIFTCARD_") === 0 || code.indexOf("LOYALTY_") === 0;
        res.status(clientErr ? 400 : 500);
        var msg = (e && e.message) || "checkout failed";
        return res.end ? res.end(msg) : res.send(msg);
      }
    });

    // PayPal express checkout (Orders v2). Mounts when the PayPal adapter is
    // wired. The pay-page PayPal button drives two AJAX calls: `create` opens
    // a PayPal order for the current cart (returns its id for the SDK to
    // approve in the popup); `capture` finalizes after approval and advances
    // the local order to paid. Both read the session cart; the button posts
    // the same ship_to fields the card form collects.
    if (deps.paypal) {
      router.post("/checkout/paypal/create", async function (req, res) {
        function _json(status, obj) {
          res.status(status);
          res.setHeader && res.setHeader("content-type", "application/json; charset=utf-8");
          var s = JSON.stringify(obj);
          return res.end ? res.end(s) : res.send(s);
        }
        var body = req.body || {};
        var sid = _readSidCookie(req);
        if (!sid) return _json(400, { error: "no-session" });
        var c = await deps.cart.bySession(sid);
        if (!c || c.status !== "active") return _json(409, { error: "no-active-cart" });
        var shipTo = {
          country: (body.country || "").toUpperCase(),
          state:   body.state ? String(body.state).toUpperCase() : undefined,
          postal:  body.postal || undefined,
        };
        try {
          var defaultShipId = typeof deps.default_shipping_id === "function"
            ? await deps.default_shipping_id() : deps.default_shipping_id;
          var created = await deps.checkout.createPaypalOrder({
            cart_id:              c.id,
            ship_to:              shipTo,
            selected_shipping_id: body.selected_shipping_id || defaultShipId || "std",
            customer:             { email: body.email, name: body.name },
            gift_card_code:       body.gift_card_code || undefined,
            idempotency_key:      "paypal:" + c.id + ":" + b.uuid.v7(),
            return_url:           body.return_url || undefined,
            cancel_url:           body.cancel_url || undefined,
          });
          // Gift card fully covered the order — no PayPal order id to
          // approve. Tell the button to redirect straight to the
          // confirmation page instead of opening the PayPal popup.
          if (!created.paypal_order_id) {
            return _json(200, { paid_by_gift_card: true, order_id: created.order.id, redirect: "/orders/" + created.order.id });
          }
          // The PayPal JS SDK's createOrder expects `{ id }`.
          return _json(200, { id: created.paypal_order_id, order_id: created.order.id });
        } catch (e) {
          var gcErr = e && typeof e.code === "string" && e.code.indexOf("GIFTCARD_") === 0;
          return _json((e instanceof TypeError || gcErr) ? 400 : 502, { error: (e && e.message) || "paypal-create-failed" });
        }
      });

      router.post("/checkout/paypal/capture", async function (req, res) {
        function _json(status, obj) {
          res.status(status);
          res.setHeader && res.setHeader("content-type", "application/json; charset=utf-8");
          var s = JSON.stringify(obj);
          return res.end ? res.end(s) : res.send(s);
        }
        var body = req.body || {};
        var paypalOrderId = body.paypal_order_id || body.orderID || body.orderId;
        if (typeof paypalOrderId !== "string" || !paypalOrderId.length) return _json(400, { error: "paypal_order_id required" });
        try {
          var result = await deps.checkout.capturePaypalOrder(paypalOrderId);
          if (!result.order) return _json(404, { error: "order-not-found" });
          // Only redirect to the order page when the capture actually
          // completed (or the order is already paid). A non-completing capture
          // leaves the order pending — surface it as an error so the client
          // doesn't show success for an unpaid order.
          if (!result.handled && result.order.status !== "paid") {
            return _json(502, { error: "capture-incomplete", status: result.order.status });
          }
          return _json(200, { order_id: result.order.id, status: result.order.status, redirect: "/orders/" + result.order.id });
        } catch (e) {
          return _json(502, { error: (e && e.message) || "paypal-capture-failed" });
        }
      });
    }

    router.get("/pay/:order_id", async function (req, res) {
      var orderId = req.params && req.params.order_id;
      if (!orderId) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      var o = await deps.order.get(orderId);
      if (!o) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      // Read the client_secret from the shop_pay cookie set on POST
      // /checkout. The cookie is scoped Path=/pay/ + SameSite=Strict
      // so it's only sent to the pay route and never cross-origin.
      var clientSecret = _readCookie(req, PAY_COOKIE_NAME);
      if (!clientSecret) {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      var pk = deps.stripe_publishable_key || "";
      if (!pk) {
        res.status(503);
        return res.end ? res.end("Stripe publishable key not configured") : res.send("Stripe publishable key not configured");
      }
      _send(res, 200, renderPayPage({
        order:           o,
        client_secret:   clientSecret,
        publishable_key: pk,
        shop_name:       shopName,
        theme:           theme,
      }));
    });

    router.get("/orders/:order_id", async function (req, res) {
      var orderId = req.params && req.params.order_id;
      if (!orderId) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      var o = await deps.order.get(orderId);
      if (!o) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      // Same variant_id → {product, hero_media} lookup pattern as the
      // cart route, applied to the order's frozen line items so the
      // post-checkout page shows what the customer bought visually.
      var productLookup = {};
      for (var i = 0; i < (o.lines || []).length; i += 1) {
        var vId = o.lines[i].variant_id;
        if (productLookup[vId]) continue;
        var v = await deps.catalog.variants.get(vId);
        if (!v) { productLookup[vId] = null; continue; }
        var prod = await deps.catalog.products.get(v.product_id);
        var media = await deps.catalog.media.listForProduct(v.product_id);
        productLookup[vId] = {
          product:    prod,
          hero_media: media.length ? media[0] : null,
        };
      }
      // "Customers also bought" rail — co-purchase signals anchored on the
      // order's own items (and excluding them, so we never recommend what
      // was just bought). Best-effort: a read failure (engine not wired /
      // tables not migrated) degrades to no rail rather than 500-ing the
      // confirmation page.
      var recommendations = [];
      if (deps.recommendations) {
        try {
          var orderProductIds = [];
          for (var li = 0; li < (o.lines || []).length; li += 1) {
            var look = productLookup[o.lines[li].variant_id];
            if (look && look.product && orderProductIds.indexOf(look.product.id) === -1) {
              orderProductIds.push(look.product.id);
            }
          }
          if (orderProductIds.length) {
            // recommendForCart aggregates the co-purchase signal across
            // EVERY purchased product (not just the first) and pivots the
            // category-popular fallback off the order's dominant
            // collection; it also self-excludes the order's own products,
            // so a multi-item order's rail reflects the whole order.
            var picks = await deps.recommendations.recommendForCart(orderProductIds, { limit: 4 });
            for (var pi = 0; pi < picks.length; pi += 1) {
              var card = await _decorateProductCard(picks[pi].product_id);
              if (card) recommendations.push(card);
            }
          }
        } catch (_e) { recommendations = []; }
      }
      _send(res, 200, renderOrder({
        order:           o,
        product_lookup:  productLookup,
        recommendations: recommendations,
        shop_name:       shopName,
        theme:           theme,
      }));
    });

    // Stripe webhook — the order-completion path. A PaymentIntent succeeds
    // asynchronously (the customer may close the tab before Stripe fires),
    // so the order's pending→paid transition lands here, not on the return
    // page. The body is verified over the RAW bytes (captured upstream by
    // webhookRawBodyCapture into req.rawBody); handleStripeEvent re-verifies
    // the signature, maps the event to an FSM transition, and dedupes
    // Stripe's re-deliveries. A bad signature is 400; a handler error is
    // 500 so Stripe retries; otherwise 200.
    router.post("/api/webhooks/stripe", async function (req, res) {
      // webhookRawBodyCapture set req.body to the exact bytes as a Buffer.
      var raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8")
        : (typeof req.body === "string" ? req.body : "");
      try {
        var result = await deps.checkout.handleStripeEvent({ headers: req.headers || {}, rawBody: raw });
        res.status(200);
        res.setHeader && res.setHeader("content-type", "application/json; charset=utf-8");
        var payload = JSON.stringify({ ok: true, handled: !!(result && result.handled) });
        return res.end ? res.end(payload) : res.send(payload);
      } catch (e) {
        if (e && e.code === "WEBHOOK_INVALID") {
          res.status(400);
          return res.end ? res.end("invalid signature") : res.send("");
        }
        // A real failure (e.g. an illegal FSM transition) — 500 so Stripe
        // retries the delivery rather than marking it permanently failed.
        res.status(500);
        return res.end ? res.end("handler error") : res.send("");
      }
    });

    // PayPal webhook — the async backstop for captures completed/refunded out
    // of band (the create/capture flow is primary). Verified server-to-server
    // through PayPal's API (handlePaypalEvent), so unlike Stripe there is no
    // edge HMAC pre-check; the raw body is captured upstream by
    // webhookRawBodyCapture. Mounts only when the PayPal adapter is wired.
    if (deps.paypal) {
      router.post("/api/webhooks/paypal", async function (req, res) {
        var raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8")
          : (typeof req.body === "string" ? req.body : "");
        try {
          var result = await deps.checkout.handlePaypalEvent({ headers: req.headers || {}, rawBody: raw });
          res.status(200);
          res.setHeader && res.setHeader("content-type", "application/json; charset=utf-8");
          var payload = JSON.stringify({ ok: true, handled: !!(result && result.handled) });
          return res.end ? res.end(payload) : res.send(payload);
        } catch (e) {
          if (e && e.code === "WEBHOOK_INVALID") {
            res.status(400);
            return res.end ? res.end("invalid signature") : res.send("");
          }
          res.status(500);
          return res.end ? res.end("handler error") : res.send("");
        }
      });
    }
  }

  // ---- gift-card balance check (customer-facing) ---------------------
  //
  // Mounts when deps.giftcards is wired. GET renders the lookup form;
  // POST looks the code up and re-renders with the balance (or a
  // generic not-found). The page is deliberately not a code-existence
  // oracle: unknown, malformed, expired, voided, and redeemed codes
  // all produce the same "couldn't find a balance" outcome.
  if (deps.giftcards) {
    router.get("/gift-cards", async function (req, res) {
      _send(res, 200, renderGiftCardBalance({
        shop_name: shopName, theme: theme, cart_count: await _cartCountForReq(req),
      }));
    });

    router.post("/gift-cards/balance", async function (req, res) {
      var body = req.body || {};
      var code = typeof body.code === "string" ? body.code : "";
      var balance = null;
      var notFound = true;
      try {
        var view = await deps.giftcards.balance(code);
        // Only an active card with a positive balance surfaces a
        // number — an expired / voided / fully-redeemed card is the
        // same dead end as an unknown code to the customer.
        if (view && view.status === "active") {
          balance = { balance_minor: view.balance_minor, currency: view.currency };
          notFound = false;
        }
      } catch (e) {
        // A malformed code throws TypeError at the canonicalizer —
        // swallow it into the same generic not-found. Any other error
        // (e.g. a DB fault) bubbles so it isn't masked as not-found.
        if (!(e instanceof TypeError)) throw e;
      }
      _send(res, 200, renderGiftCardBalance({
        shop_name: shopName, theme: theme, cart_count: await _cartCountForReq(req),
        balance: balance, not_found: notFound,
      }));
    });
  }

  // ---- customer accounts (passkey-only) ------------------------------
  //
  // Mount only when deps.customers is supplied (operator opts in by
  // wiring the customers primitive in server.js). The account routes
  // also depend on b.vault for sealed-cookie envelopes — the seal /
  // unseal calls throw `vault/not-initialized` at request time when
  // the operator hasn't supplied VAULT_PASSPHRASE; routes surface
  // that as 503 so the rest of the storefront stays up.
  if (deps.customers) {
    var rpName = shopName;
    var rpId   = deps.rpId || (deps.shop_origin ? new URL(deps.shop_origin).hostname : "localhost");
    var expectedOrigin = deps.shop_origin || ("https://" + rpId);

    function _b64u(buf) {
      return b.crypto.toBase64Url(buf);
    }

    function _currentCustomer(req) {
      return _currentCustomerEnv(req);
    }

    function _serviceUnavailable(res, msg) {
      res.status(503);
      return res.end ? res.end(msg) : res.send(msg);
    }

    // Attribute a freshly-created customer to the referrer named in the
    // sealed referral cookie, then clear the cookie so it can't attribute
    // a later signup. Guards:
    //   * no cookie / unknown / disabled code → no-op (silent)
    //   * self-referral (the code belongs to this customer) → no-op
    //   * already-attributed (trackSignup pins to the oldest pending
    //     invitation; a customer with one already pinned won't get a
    //     second) → no-op
    // Best-effort: a referrals failure never blocks the signup. Mounts
    // only when the referrals primitive is wired. The cookie is always
    // cleared (even on a guarded no-op) so a stale code doesn't linger.
    async function _attributeReferral(req, res, newCustomerId) {
      if (!deps.referrals) return;
      var env = null;
      try { env = _readReferralEnv(req); } catch (_e) { env = null; }
      // Clear regardless — one shot per signup.
      try { _clearReferralCookie(res); } catch (_e) { /* best-effort */ }
      if (!env || !env.code) return;
      try {
        var row = await deps.referrals.byCode(env.code);
        if (!row || row.status !== "active") return;
        // Self-referral guard — a customer can't refer themselves.
        if (row.referrer_customer_id === newCustomerId) return;
        await deps.referrals.trackSignup({ code: env.code, customer_id: newCustomerId });
      } catch (_e) { /* drop-silent — attribution is best-effort, signup wins */ }
    }

    function _readJsonBody(req) {
      // b.middleware.bodyParser leaves JSON in req.body when the
      // request's content-type is application/json. Some test
      // harnesses POST a string body — fall back to JSON.parse.
      if (req.body && typeof req.body === "object") return req.body;
      if (typeof req.body === "string") {
        try { return JSON.parse(req.body); } catch (_e) { return {}; }
      }
      return {};
    }

    router.get("/account/login", async function (req, res) {
      var cartCount = await _cartCountForReq(req);
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      _send(res, 200, renderAccountLogin({
        shop_name:      shopName,
        cart_count:     cartCount,
        google_enabled: !!deps.oauthGoogle,
        apple_enabled:  !!deps.oauthApple,
        error:          url && url.searchParams.get("error"),
      }));
    });

    router.get("/account/register", async function (req, res) {
      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderAccountRegister({ shop_name: shopName, cart_count: cartCount }));
    });

    router.post("/account/passkey/register-begin", async function (req, res) {
      try {
        var body = _readJsonBody(req);
        // Persist the customer row up-front. The address is the
        // registration's natural identifier — if enrollment fails
        // the customer can re-attempt with the same email; the
        // primitive's duplicate-refusal surfaces as a typed code.
        var existing = await deps.customers.byEmailHash(
          deps.customers.hashEmail(body.email),
        );
        var customer;
        if (existing) {
          customer = existing;
        } else {
          customer = await deps.customers.register({
            email:        body.email,
            display_name: body.display_name,
          });
        }
        var startOpts = await b.auth.passkey.startRegistration({
          rpName:           rpName,
          rpId:             rpId,
          userName:         customer.email_hash.slice(0, 16),
          userDisplayName:  customer.display_name,
          attestationType:  "none",
        });
        // Seal the ceremony state (challenge + customer_id) into the
        // shop_auth_chal cookie so register-finish verifies against
        // the same challenge without server-side state.
        _setChallengeCookie(res, {
          kind:           "register",
          customer_id:    customer.id,
          challenge:      startOpts.challenge,
          created_at:     Date.now(),
        });
        res.status(200);
        res.setHeader && res.setHeader("content-type", "application/json");
        return res.end ? res.end(JSON.stringify(startOpts)) : res.send(JSON.stringify(startOpts));
      } catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "register-begin failed") : res.send((e && e.message) || "register-begin failed");
      }
    });

    router.post("/account/passkey/register-finish", async function (req, res) {
      try {
        var env = _readChallengeEnv(req);
        if (!env) { res.status(400); return res.end ? res.end("missing challenge") : res.send("missing challenge"); }
        if (env.kind !== "register") {
          res.status(400); return res.end ? res.end("bad challenge") : res.send("bad challenge");
        }
        var att = _readJsonBody(req);
        var rv = await b.auth.passkey.verifyRegistration({
          response:           att,
          expectedChallenge:  env.challenge,
          expectedOrigin:     expectedOrigin,
          expectedRPID:       rpId,
        });
        if (!rv || !rv.verified) {
          res.status(400); return res.end ? res.end("attestation refused") : res.send("attestation refused");
        }
        var info = rv.registrationInfo || {};
        var credentialId = info.credentialID || att.rawId || att.id;
        var publicKey    = info.credentialPublicKey;
        if (credentialId && typeof credentialId !== "string") credentialId = _b64u(credentialId);
        if (publicKey && typeof publicKey !== "string")       publicKey    = _b64u(publicKey);
        var transports = "";
        if (att.response && Array.isArray(att.response.transports)) {
          transports = att.response.transports.filter(function (t) { return /^[a-z]+$/.test(t); }).join(",");
        }
        await deps.customers.addPasskey(env.customer_id, {
          credential_id: credentialId,
          public_key:    publicKey,
          counter:       info.counter || 0,
          transports:    transports,
        });
        _clearChallengeCookie(res);
        _setAuthCookie(res, {
          customer_id: env.customer_id,
          exp:         Date.now() + b.constants.TIME.days(14),
        });
        // Attribute this signup to a referrer if the visitor arrived
        // through a /r/<code> link. Best-effort — never blocks the
        // ceremony's success response. trackSignup pins to the oldest
        // pending invitation under the code, so re-running register-finish
        // for the same account doesn't double-attribute.
        await _attributeReferral(req, res, env.customer_id);
        res.status(200);
        return res.end ? res.end("ok") : res.send("ok");
      } catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "register-finish failed") : res.send((e && e.message) || "register-finish failed");
      }
    });

    router.post("/account/passkey/login-begin", async function (req, res) {
      try {
        var body = _readJsonBody(req);
        var hash = deps.customers.hashEmail(body.email);
        var customer = await deps.customers.byEmailHash(hash);
        // Even when the customer doesn't exist, return a valid-shaped
        // challenge with an empty allowCredentials list — the client
        // can't distinguish "no such address" from "wrong passkey",
        // protecting against email-enumeration.
        var allow = [];
        if (customer) {
          var pks = await deps.customers.listPasskeys(customer.id);
          allow = pks.map(function (p) {
            return {
              id:         p.credential_id,
              type:       "public-key",
              transports: p.transports ? p.transports.split(",") : undefined,
            };
          });
        }
        var startOpts = await b.auth.passkey.startAuthentication({
          rpId:                 rpId,
          allowCredentials:     allow,
          userVerification:     "preferred",
        });
        _setChallengeCookie(res, {
          kind:        "login",
          email_hash:  hash,
          challenge:   startOpts.challenge,
          created_at:  Date.now(),
        });
        res.status(200);
        res.setHeader && res.setHeader("content-type", "application/json");
        return res.end ? res.end(JSON.stringify(startOpts)) : res.send(JSON.stringify(startOpts));
      } catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "login-begin failed") : res.send((e && e.message) || "login-begin failed");
      }
    });

    router.post("/account/passkey/login-finish", async function (req, res) {
      try {
        var env = _readChallengeEnv(req);
        if (!env) { res.status(400); return res.end ? res.end("missing challenge") : res.send("missing challenge"); }
        if (env.kind !== "login") { res.status(400); return res.end ? res.end("bad challenge") : res.send("bad challenge"); }
        var assertion = _readJsonBody(req);
        var credentialId = assertion.id || assertion.rawId;
        if (!credentialId) { res.status(400); return res.end ? res.end("missing credential id") : res.send("missing credential id"); }
        var passkey = await deps.customers.getPasskeyByCredentialId(credentialId);
        if (!passkey) { res.status(401); return res.end ? res.end("unknown credential") : res.send("unknown credential"); }
        var customer = await deps.customers.get(passkey.customer_id);
        if (!customer) { res.status(401); return res.end ? res.end("unknown customer") : res.send("unknown customer"); }
        if (customer.email_hash !== env.email_hash) {
          // The login-begin email and the credential's customer
          // must agree — refuse cross-account credential reuse.
          res.status(401); return res.end ? res.end("credential / account mismatch") : res.send("credential / account mismatch");
        }
        var rv = await b.auth.passkey.verifyAuthentication({
          response:                assertion,
          expectedChallenge:       env.challenge,
          expectedOrigin:          expectedOrigin,
          expectedRPID:            rpId,
          authenticator: {
            credentialID:          passkey.credential_id,
            credentialPublicKey:   passkey.public_key,
            counter:               passkey.counter,
          },
        });
        if (!rv || !rv.verified) {
          res.status(401); return res.end ? res.end("assertion refused") : res.send("assertion refused");
        }
        // Persist the new counter value (clone-detection).
        var newCounter = (rv.authenticationInfo && rv.authenticationInfo.newCounter) || 0;
        try {
          await deps.customers.updatePasskeyCounter(passkey.id, newCounter);
        } catch (e) {
          if (e && e.code === "PASSKEY_COUNTER_REGRESSION") {
            res.status(401); return res.end ? res.end("counter regression — possible clone") : res.send("counter regression — possible clone");
          }
          throw e;
        }
        // Merge the anonymous cart into a customer-owned cart so
        // the shopper doesn't lose items on sign-in.
        var sid = _readSidCookie(req);
        if (sid) {
          try {
            var anonCart = await deps.cart.bySession(sid);
            if (anonCart) await deps.cart.setCustomer(anonCart.id, customer.id);
          } catch (_e) { /* best-effort merge; sign-in itself succeeds */ }
        }
        _clearChallengeCookie(res);
        _setAuthCookie(res, {
          customer_id: customer.id,
          exp:         Date.now() + b.constants.TIME.days(14),
        });
        res.status(200);
        return res.end ? res.end("ok") : res.send("ok");
      } catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "login-finish failed") : res.send((e && e.message) || "login-finish failed");
      }
    });

    router.get("/account", async function (req, res) {
      var auth;
      try { auth = _currentCustomer(req); }
      catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        throw e;
      }
      if (!auth) {
        res.status(303); res.setHeader && res.setHeader("location", "/account/login");
        return res.end ? res.end() : res.send("");
      }
      var customer = await deps.customers.get(auth.customer_id);
      if (!customer) {
        _clearAuthCookie(res);
        res.status(303); res.setHeader && res.setHeader("location", "/account/login");
        return res.end ? res.end() : res.send("");
      }
      var orders = [];
      if (deps.order) {
        var page = await deps.order.listForCustomer(customer.id, { limit: 10 });
        orders = page.rows;
      }
      // Per-order product thumbnails. For each order, walk its
      // frozen lines, collapse to unique variant ids, then resolve
      // each through cached `catalog.variants.get` →
      // `catalog.products.get` + `catalog.media.listForProduct`.
      // The per-order list is capped at the first four entries the
      // renderer surfaces (with a "+N" overflow chip when there are
      // more) so a multi-line order doesn't blow up the table row.
      var orderProductLookup = {};
      var variantCache = {};
      for (var oi = 0; oi < orders.length; oi += 1) {
        var ord = orders[oi];
        var entries = [];
        var seen = {};
        for (var li = 0; li < (ord.lines || []).length; li += 1) {
          var vId = ord.lines[li].variant_id;
          if (seen[vId]) continue;
          seen[vId] = true;
          if (!variantCache[vId]) {
            var v = await deps.catalog.variants.get(vId);
            if (!v) { variantCache[vId] = null; continue; }
            var prod  = await deps.catalog.products.get(v.product_id);
            var media = await deps.catalog.media.listForProduct(v.product_id);
            variantCache[vId] = {
              product:    prod,
              hero_media: media.length ? media[0] : null,
            };
          }
          if (variantCache[vId]) entries.push(variantCache[vId]);
        }
        orderProductLookup[ord.id] = entries;
      }
      // Passkey count — how many devices the customer has enrolled.
      var passkeyCount = 0;
      try {
        var pks = await deps.customers.listPasskeys(customer.id);
        passkeyCount = Array.isArray(pks) ? pks.length : 0;
      } catch (_e) { /* drop-silent — primitive may not expose listPasskeys on every build */ }

      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderAccount({
        customer:              customer,
        orders:                orders,
        order_product_lookup:  orderProductLookup,
        passkey_count:         passkeyCount,
        shop_name:             shopName,
        cart_count:            cartCount,
      }));
    });

    router.post("/account/logout", function (_req, res) {
      _clearAuthCookie(res);
      res.status(303); res.setHeader && res.setHeader("location", "/");
      return res.end ? res.end() : res.send("");
    });

    // Sign in with Google (OIDC). Mounts when the operator wires an
    // `oauthGoogle` adapter (b.auth.oauth, google preset). The framework
    // adapter owns discovery + PKCE + ID-token verification (signature,
    // iss, aud, exp, nonce); this layer manages the sealed in-flight
    // state cookie and turns the verified identity into a shop session
    // via customers.signInWithOIDC (which gates account linking on a
    // verified email).
    if (deps.oauthGoogle) {
      router.get("/account/login/google", async function (req, res) {
        try {
          var a = await deps.oauthGoogle.authorizationUrl({ prompt: "select_account" });
          _cookieJar().writeSealed(res, OAUTH_COOKIE_NAME, JSON.stringify({
            provider: "google", state: a.state, nonce: a.nonce, verifier: a.verifier,
          }), { expires: new Date(Date.now() + b.constants.TIME.minutes(10)), path: "/account", sameSite: "Lax" });
          res.status(302);
          res.setHeader && res.setHeader("location", a.url);
          return res.end ? res.end() : res.send("");
        } catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return; }
          res.status(303); res.setHeader && res.setHeader("location", "/account/login?error=oauth");
          return res.end ? res.end() : res.send("");
        }
      });

      router.get("/account/auth/google/callback", async function (req, res) {
        function _toLogin(err) {
          res.status(303);
          res.setHeader && res.setHeader("location", "/account/login" + (err ? "?error=" + err : ""));
          return res.end ? res.end() : res.send("");
        }
        var url   = req.url ? new URL(req.url, "http://localhost") : null;
        var code  = url && url.searchParams.get("code");
        var state = url && url.searchParams.get("state");
        if (!code || !state) return _toLogin("oauth");

        // Recover + clear the sealed sign-in state; the CSRF state must
        // match the value we issued (a forged callback is dropped here).
        var saved;
        try { var raw = _cookieJar().readSealed(req, OAUTH_COOKIE_NAME); saved = raw ? JSON.parse(raw) : null; }
        catch (_e) { saved = null; }
        _cookieJar().clear(res, OAUTH_COOKIE_NAME, { path: "/account" });
        if (!saved || saved.provider !== "google" || saved.state !== state) return _toLogin("oauth");

        var claims;
        try {
          var tokens = await deps.oauthGoogle.exchangeCode({ code: code, verifier: saved.verifier, nonce: saved.nonce });
          claims = tokens && tokens.claims;
        } catch (_e) { return _toLogin("oauth"); }
        if (!claims || !claims.sub) return _toLogin("oauth");

        var rv;
        try {
          rv = await deps.customers.signInWithOIDC({
            provider:       "google",
            subject:        String(claims.sub),
            email:          claims.email,
            email_verified: claims.email_verified === true,
            display_name:   claims.name,
          });
        } catch (e) {
          if (e && e.code === "OAUTH_EMAIL_UNVERIFIED_CONFLICT") return _toLogin("email-conflict");
          if (e instanceof TypeError) return _toLogin("oauth");
          throw e;
        }
        // Adopt the guest cart into the now-authenticated account so a
        // cart built before sign-in isn't lost — and so checkout.confirm
        // (which derives order.customer_id from cart.customer_id) attaches
        // the order to the customer. Mirrors the passkey login path.
        var sid = _readSidCookie(req);
        if (sid) {
          try {
            var anonCart = await deps.cart.bySession(sid);
            if (anonCart) await deps.cart.setCustomer(anonCart.id, rv.customer.id);
          } catch (_e) { /* best-effort merge; sign-in itself succeeds */ }
        }
        // Claim prior guest orders placed under this email — ONLY because
        // the provider verified it (claims.email_verified). Links orders
        // with no owner yet whose recorded email hash matches; best-effort.
        if (claims.email_verified === true && claims.email && deps.order &&
            typeof deps.order.linkGuestOrdersByEmailHash === "function") {
          try {
            await deps.order.linkGuestOrdersByEmailHash(rv.customer.id, deps.customers.hashEmail(claims.email));
          } catch (_e) { /* best-effort reconciliation; sign-in succeeds regardless */ }
        }
        // Attribute a referral ONLY on a genuinely new account
        // (rv.created) — an existing customer signing in through Google
        // is not a new signup and must not be attributed to a referrer.
        if (rv.created === true) {
          await _attributeReferral(req, res, rv.customer.id);
        } else {
          try { _clearReferralCookie(res); } catch (_e) { /* best-effort */ }
        }
        _setAuthCookie(res, { customer_id: rv.customer.id, exp: Date.now() + b.constants.TIME.days(14) });
        res.status(303); res.setHeader && res.setHeader("location", "/account");
        return res.end ? res.end() : res.send("");
      });
    }

    // Sign in with Apple (OIDC). Mounts when the operator wires an
    // `oauthApple` adapter (b.auth.oauth, apple preset). Two differences
    // from Google: (1) Apple uses response_mode=form_post, so the callback
    // is a POST whose `code`/`state` arrive in the form body, not the query
    // string; (2) Apple returns the user's name ONLY on the first
    // authorization, in a `user` form field (JSON) — never in the ID token
    // — so we read it from there and fall back to the (usually absent)
    // token name. Everything after the verified identity (sealed-state
    // check, sign-in, cart merge, guest-order reconciliation, auth cookie)
    // mirrors the Google path.
    if (deps.oauthApple) {
      router.get("/account/login/apple", async function (req, res) {
        try {
          var a = await deps.oauthApple.authorizationUrl({});
          // Apple returns via response_mode=form_post — a CROSS-SITE POST
          // from appleid.apple.com back to our callback. A SameSite=Lax
          // cookie is NOT sent on a cross-site POST navigation (Lax only
          // covers top-level GETs), so the sealed state would be lost and
          // every sign-in would fail. It must be SameSite=None; Secure.
          // (Google's callback is a GET, so Lax is fine there.)
          _cookieJar().writeSealed(res, OAUTH_COOKIE_NAME, JSON.stringify({
            provider: "apple", state: a.state, nonce: a.nonce, verifier: a.verifier,
          }), { expires: new Date(Date.now() + b.constants.TIME.minutes(10)), path: "/account", sameSite: "None", secure: true });
          res.status(302);
          res.setHeader && res.setHeader("location", a.url);
          return res.end ? res.end() : res.send("");
        } catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return; }
          res.status(303); res.setHeader && res.setHeader("location", "/account/login?error=oauth");
          return res.end ? res.end() : res.send("");
        }
      });

      router.post("/account/auth/apple/callback", async function (req, res) {
        function _toLogin(err) {
          res.status(303);
          res.setHeader && res.setHeader("location", "/account/login" + (err ? "?error=" + err : ""));
          return res.end ? res.end() : res.send("");
        }
        // form_post: code + state (+ the first-auth `user` blob) are in the
        // request body, not the query string.
        var body  = req.body || {};
        var code  = body.code;
        var state = body.state;
        if (!code || !state) return _toLogin("oauth");

        var saved;
        try { var raw = _cookieJar().readSealed(req, OAUTH_COOKIE_NAME); saved = raw ? JSON.parse(raw) : null; }
        catch (_e) { saved = null; }
        _cookieJar().clear(res, OAUTH_COOKIE_NAME, { path: "/account" });
        if (!saved || saved.provider !== "apple" || saved.state !== state) return _toLogin("oauth");

        var claims;
        try {
          var tokens = await deps.oauthApple.exchangeCode({ code: code, verifier: saved.verifier, nonce: saved.nonce });
          claims = tokens && tokens.claims;
        } catch (_e) { return _toLogin("oauth"); }
        if (!claims || !claims.sub) return _toLogin("oauth");

        // Apple sends the display name only on first consent, as a JSON
        // `user` form field: { name: { firstName, lastName }, email }.
        var displayName = claims.name || null;
        if (typeof body.user === "string" && body.user.length) {
          try {
            var u = JSON.parse(body.user);
            if (u && u.name) {
              displayName = [u.name.firstName, u.name.lastName].filter(Boolean).join(" ") || displayName;
            }
          } catch (_e) { /* malformed user blob — fall back to the token name */ }
        }
        // Apple's email_verified arrives as a boolean OR the string "true".
        var emailVerified = claims.email_verified === true || claims.email_verified === "true";

        var rv;
        try {
          rv = await deps.customers.signInWithOIDC({
            provider:       "apple",
            subject:        String(claims.sub),
            email:          claims.email,
            email_verified: emailVerified,
            display_name:   displayName,
          });
        } catch (e) {
          if (e && e.code === "OAUTH_EMAIL_UNVERIFIED_CONFLICT") return _toLogin("email-conflict");
          if (e instanceof TypeError) return _toLogin("oauth");
          throw e;
        }
        var sid = _readSidCookie(req);
        if (sid) {
          try {
            var anonCart = await deps.cart.bySession(sid);
            if (anonCart) await deps.cart.setCustomer(anonCart.id, rv.customer.id);
          } catch (_e) { /* best-effort merge; sign-in itself succeeds */ }
        }
        if (emailVerified && claims.email && deps.order &&
            typeof deps.order.linkGuestOrdersByEmailHash === "function") {
          try {
            await deps.order.linkGuestOrdersByEmailHash(rv.customer.id, deps.customers.hashEmail(claims.email));
          } catch (_e) { /* best-effort reconciliation; sign-in succeeds regardless */ }
        }
        // Attribute a referral ONLY on a genuinely new account (rv.created)
        // — mirrors the Google path.
        if (rv.created === true) {
          await _attributeReferral(req, res, rv.customer.id);
        } else {
          try { _clearReferralCookie(res); } catch (_e) { /* best-effort */ }
        }
        _setAuthCookie(res, { customer_id: rv.customer.id, exp: Date.now() + b.constants.TIME.days(14) });
        res.status(303); res.setHeader && res.setHeader("location", "/account");
        return res.end ? res.end() : res.send("");
      });
    }

    // Wishlist — saved products scoped to the logged-in customer.
    // Mounts when the wishlist primitive is wired.
    if (deps.wishlist) {
      // POST /wishlist/toggle — add the product if not saved, remove it
      // if already saved. Login required (the wishlist is per-customer).
      // Redirects to `return_to` when it's a safe same-origin path
      // (the account page's Remove uses it), otherwise back to the
      // product PDP (the canonical slug is resolved from product_id, so
      // a forged slug can't drive an open redirect).
      router.post("/wishlist/toggle", async function (req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          return res.end ? res.end() : res.send("");
        }
        var productId = (req.body || {}).product_id;
        try {
          var already = await deps.wishlist.isWishlisted({ customer_id: auth.customer_id, product_id: productId });
          if (already) await deps.wishlist.remove({ customer_id: auth.customer_id, product_id: productId });
          else         await deps.wishlist.add({ customer_id: auth.customer_id, product_id: productId });
        } catch (e) {
          res.status(e instanceof TypeError ? 400 : 500);
          return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
        }
        var rt = (req.body || {}).return_to;
        var dest;
        if (typeof rt === "string" && /^\/[^/]/.test(rt)) {
          dest = rt;
        } else {
          var product = null;
          try { product = await deps.catalog.products.get(productId); } catch (_e) { product = null; }
          dest = product ? ("/products/" + encodeURIComponent(product.slug)) : "/account/wishlist";
        }
        res.status(303); res.setHeader && res.setHeader("location", dest);
        return res.end ? res.end() : res.send("");
      });

      // GET /account/wishlist — the customer's saved items. Each entry
      // resolves its product + hero image; an entry whose product was
      // archived renders as "unavailable" (the row is orphan-tolerant).
      router.get("/account/wishlist", async function (req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          return res.end ? res.end() : res.send("");
        }
        var page = await deps.wishlist.listForCustomer(auth.customer_id, { limit: 50 });
        var items = [];
        for (var i = 0; i < page.rows.length; i += 1) {
          var entry = page.rows[i];
          var product = null;
          try { product = await deps.catalog.products.get(entry.product_id); } catch (_e) { product = null; }
          if (!product) { items.push({ product: null, product_id: entry.product_id }); continue; }
          var media = await deps.catalog.media.listForProduct(product.id);
          items.push({ product: product, hero_media: media.length ? media[0] : null });
        }
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderWishlist({
          items:        items,
          shop_name:    shopName,
          cart_count:   cartCount,
          asset_prefix: deps.asset_prefix || "/assets/",
        }));
      });
    }

    // Save for later — move a cart line into a per-customer holding
    // list and back. Login required (the list is per-customer).
    if (deps.saveForLater) {
      function _savedAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }

      // POST /cart/lines/:line_id/save — move the line out of the cart
      // into the customer's saved list. Redirects back to /cart.
      router.post("/cart/lines/:line_id/save", async function (req, res) {
        var auth = _savedAuth(req, res);
        if (!auth) return;
        var sid = _readSidCookie(req);
        var cart = sid ? await deps.cart.bySession(sid) : null;
        if (!cart) {
          res.status(303); res.setHeader && res.setHeader("location", "/cart");
          return res.end ? res.end() : res.send("");
        }
        try {
          await deps.saveForLater.moveFromCart({
            customer_id: auth.customer_id,
            cart_id:     cart.id,
            line_id:     req.params && req.params.line_id,
          });
        } catch (e) {
          res.status(e instanceof TypeError ? 400 : 500);
          return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
        }
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      });

      // GET /account/saved — the customer's saved-for-later list.
      router.get("/account/saved", async function (req, res) {
        var auth = _savedAuth(req, res);
        if (!auth) return;
        var page = await deps.saveForLater.listForCustomer({ customer_id: auth.customer_id, limit: 50 });
        var items = [];
        for (var i = 0; i < page.rows.length; i += 1) {
          var row = page.rows[i];
          var product = null;
          if (row.variant_id) {
            try {
              var v = await deps.catalog.variants.get(row.variant_id);
              if (v) product = await deps.catalog.products.get(v.product_id);
            } catch (_e) { product = null; }
          }
          if (!product) { items.push({ save: row, product: null }); continue; }
          var media = await deps.catalog.media.listForProduct(product.id);
          items.push({ save: row, product: product, hero_media: media.length ? media[0] : null });
        }
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderSaved({
          items:        items,
          shop_name:    shopName,
          cart_count:   cartCount,
          asset_prefix: deps.asset_prefix || "/assets/",
        }));
      });

      // POST /saved/:save_id/move-to-cart — move a saved row back into
      // the session cart (created if absent). Redirects to /cart.
      router.post("/saved/:save_id/move-to-cart", async function (req, res) {
        var auth = _savedAuth(req, res);
        if (!auth) return;
        var resolved = await _getOrCreateCart(req, res, "USD");
        try {
          await deps.saveForLater.moveToCart({
            customer_id: auth.customer_id,
            save_id:     req.params && req.params.save_id,
            cart_id:     resolved.cart.id,
            // Reprice to the live catalog price so the cart never carries
            // a stale snapshot; the saved page shows the snapshot for
            // reference only.
            use_price:   "current",
          });
        } catch (e) {
          if (e instanceof TypeError) {
            res.status(400);
            return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
          }
          // The cart enforces one line per (cart_id, variant_id). If the
          // shopper re-added this variant before moving the saved copy,
          // moveToCart's INSERT collides — but the end state they want
          // (variant in the cart) already holds. Drop the saved row and
          // treat it as success instead of surfacing a 500. The lib
          // leaves the save row intact on collision, so removing it here
          // is what completes the "move".
          if (/unique|constraint/i.test((e && e.message) || "")) {
            try {
              await deps.saveForLater.remove({ customer_id: auth.customer_id, save_id: req.params && req.params.save_id });
            } catch (_e) { /* drop-silent — the move is already effectively done */ }
            res.status(303); res.setHeader && res.setHeader("location", "/cart");
            return res.end ? res.end() : res.send("");
          }
          throw e;
        }
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      });

      // POST /saved/:save_id/remove — drop a saved row.
      router.post("/saved/:save_id/remove", async function (req, res) {
        var auth = _savedAuth(req, res);
        if (!auth) return;
        try {
          await deps.saveForLater.remove({ customer_id: auth.customer_id, save_id: req.params && req.params.save_id });
        } catch (e) {
          res.status(e instanceof TypeError ? 400 : 500);
          return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/saved");
        return res.end ? res.end() : res.send("");
      });
    }

    // Address book — per-customer saved addresses. Every by-id route
    // verifies the address belongs to the authed customer before acting
    // (the primitive operates by id alone, so ownership is enforced here
    // to prevent cross-customer access via a guessed id).
    if (deps.addresses) {
      function _addrAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }
      async function _ownedAddress(req, res, auth) {
        var addr;
        try {
          addr = await deps.addresses.get(req.params && req.params.id);
        } catch (e) {
          // `get` throws TypeError on a non-UUID id — a malformed path
          // segment is a 404, not a 500.
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!addr || addr.customer_id !== auth.customer_id || Number(addr.is_archived) === 1) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return null;
        }
        return addr;
      }
      async function _renderAddrPage(req, res, auth, editAddr, notice, code) {
        var rows = await deps.addresses.listForCustomer(auth.customer_id, { limit: 50 });
        var cartCount = await _cartCountForReq(req);
        _send(res, code || 200, renderAddresses({
          addresses:  rows,
          edit:       editAddr || null,
          notice:     notice || null,
          shop_name:  shopName,
          cart_count: cartCount,
        }));
      }
      function _addrInput(body, customerId) {
        return {
          customer_id:         customerId,
          label:               body.label,
          recipient_name:      body.recipient_name,
          company:             body.company,
          street_line1:        body.street_line1,
          street_line2:        body.street_line2,
          city:                body.city,
          region:              body.region,
          postal_code:         body.postal_code,
          country:             body.country,
          phone:               body.phone,
          // Checkboxes arrive as "1" when ticked, absent otherwise — the
          // primitive's _bool wants an integer, so coerce here.
          is_default_shipping: body.is_default_shipping === "1" ? 1 : 0,
          is_default_billing:  body.is_default_billing === "1" ? 1 : 0,
        };
      }

      router.get("/account/addresses", async function (req, res) {
        var auth = _addrAuth(req, res); if (!auth) return;
        await _renderAddrPage(req, res, auth, null);
      });

      router.get("/account/addresses/:id/edit", async function (req, res) {
        var auth = _addrAuth(req, res); if (!auth) return;
        var addr = await _ownedAddress(req, res, auth); if (!addr) return;
        await _renderAddrPage(req, res, auth, addr);
      });

      router.post("/account/addresses", async function (req, res) {
        var auth = _addrAuth(req, res); if (!auth) return;
        try {
          await deps.addresses.add(_addrInput(req.body || {}, auth.customer_id));
        } catch (e) {
          if (e instanceof TypeError) return _renderAddrPage(req, res, auth, null, (e && e.message) || "Please check the address.", 400);
          throw e;
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/addresses");
        return res.end ? res.end() : res.send("");
      });

      router.post("/account/addresses/:id", async function (req, res) {
        var auth = _addrAuth(req, res); if (!auth) return;
        var addr = await _ownedAddress(req, res, auth); if (!addr) return;
        try {
          await deps.addresses.update(addr.id, _addrInput(req.body || {}, auth.customer_id));
        } catch (e) {
          if (e instanceof TypeError) {
            var merged = Object.assign({}, addr, _addrInput(req.body || {}, auth.customer_id));
            return _renderAddrPage(req, res, auth, merged, (e && e.message) || "Please check the address.", 400);
          }
          throw e;
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/addresses");
        return res.end ? res.end() : res.send("");
      });

      function _addrAction(verb, fn) {
        router.post("/account/addresses/:id/" + verb, async function (req, res) {
          var auth = _addrAuth(req, res); if (!auth) return;
          var addr = await _ownedAddress(req, res, auth); if (!addr) return;
          try { await fn(addr.id); }
          catch (e) {
            res.status(e instanceof TypeError ? 400 : 500);
            return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
          }
          res.status(303); res.setHeader && res.setHeader("location", "/account/addresses");
          return res.end ? res.end() : res.send("");
        });
      }
      _addrAction("default-shipping", function (id) { return deps.addresses.setDefaultShipping(id); });
      _addrAction("default-billing",  function (id) { return deps.addresses.setDefaultBilling(id); });
      _addrAction("archive",          function (id) { return deps.addresses.archive(id); });
    }

    // Subscription self-management — the signed-in customer views their
    // own recurring subscriptions and cancels them. The list mounts on
    // the subscriptions primitive alone; the cancel route additionally
    // needs the payment handle (cancel composes Stripe through
    // `subscriptions.subscriptions.cancel`, mirroring the admin gate). A
    // subscription is fetched + ownership-checked against the authed
    // customer before any cancel — a guessed/forged id never reaches
    // another customer's row. Creation (a Stripe subscription-checkout
    // flow) is a separate surface; this is the management view.
    if (subscriptions) {
      var subsCanCancel = !!deps.payment;

      function _subsAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }

      // Resolve the customer's subscriptions and join each to its plan.
      // Plans are batched: one `plans.get` per distinct plan_id, cached
      // across rows, so a customer with many subscriptions on the same
      // plan costs one plan read, not one per subscription (no N+1). A
      // read failure (table not migrated) degrades to an empty list
      // rather than 500-ing the account page.
      async function _subsForCustomer(customerId) {
        var rows;
        try { rows = await subscriptions.subscriptions.list({ customer_id: customerId }); }
        catch (e) {
          if (e instanceof TypeError) return [];
          throw e;
        }
        var planCache = {};
        for (var i = 0; i < rows.length; i += 1) {
          var pid = rows[i].plan_id;
          if (pid != null && !Object.prototype.hasOwnProperty.call(planCache, pid)) {
            try { planCache[pid] = await subscriptions.plans.get(pid); }
            catch (_e) { planCache[pid] = null; }
          }
          rows[i].plan = pid != null ? planCache[pid] : null;
        }
        return rows;
      }

      // Load the subscription named in :id and confirm it belongs to the
      // signed-in customer. A malformed id (guardUuid TypeError), a
      // missing row, or another customer's subscription all return null
      // after sending a 404 — never a 500, never a cross-customer cancel.
      async function _ownedSubscription(req, res, auth) {
        var sub;
        try { sub = await subscriptions.subscriptions.get(req.params && req.params.id); }
        catch (e) {
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!sub || sub.customer_id !== auth.customer_id) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return null;
        }
        return sub;
      }

      router.get("/account/subscriptions", async function (req, res) {
        var auth = _subsAuth(req, res); if (!auth) return;
        var rows = await _subsForCustomer(auth.customer_id);
        var cartCount = await _cartCountForReq(req);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var canceled = !!(url && url.searchParams.get("canceled"));
        _send(res, 200, renderAccountSubscriptions({
          subscriptions: rows,
          can_cancel:    subsCanCancel,
          notice:        canceled ? "Your subscription has been canceled." : null,
          shop_name:     shopName,
          cart_count:    cartCount,
        }));
      });

      // Cancel mounts only when payment is wired (cancel composes Stripe).
      // Without payment the list above stays read-only with a note.
      if (deps.payment) {
        router.post("/account/subscriptions/:id/cancel", async function (req, res) {
          var auth = _subsAuth(req, res); if (!auth) return;
          var sub = await _ownedSubscription(req, res, auth); if (!sub) return;
          // Default cancel-at-period-end (the customer keeps access through
          // the period they've paid for); the form opts into immediate via
          // the `immediate` checkbox.
          var atPeriodEnd = !((req.body || {}).immediate === "1");
          try {
            await subscriptions.subscriptions.cancel(sub.id, { at_period_end: atPeriodEnd });
          } catch (e) {
            // A bad id was already screened by _ownedSubscription; a
            // downstream TypeError (shape) bounces back to the list with a
            // notice rather than 500-ing.
            if (e instanceof TypeError) {
              res.status(303); res.setHeader && res.setHeader("location", "/account/subscriptions");
              return res.end ? res.end() : res.send("");
            }
            throw e;
          }
          res.status(303); res.setHeader && res.setHeader("location", "/account/subscriptions?canceled=1");
          return res.end ? res.end() : res.send("");
        });
      }
    }

    // Self-serve returns — a customer requests an RMA against one of
    // their own orders and tracks its status. Operators action it via
    // the admin /admin/returns queue. Needs the returns primitive + an
    // order handle (to load + ownership-check the order being returned).
    if (deps.returns && deps.order) {
      function _returnsAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }
      // Load the order named in :order_id and confirm it belongs to the
      // signed-in customer. A malformed id (guardUuid TypeError), a
      // missing order, or someone else's order all return 404 — never a
      // 500, never a leak of another customer's order.
      async function _ownedOrder(req, res, auth) {
        var order;
        try { order = await deps.order.get(req.params && req.params.order_id); }
        catch (e) {
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!order || order.customer_id !== auth.customer_id) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return null;
        }
        return order;
      }

      router.get("/account/returns", async function (req, res) {
        var auth = _returnsAuth(req, res); if (!auth) return;
        var page = await deps.returns.listForCustomer(auth.customer_id, { limit: 50 });
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderReturns({ rmas: page.rows, shop_name: shopName, cart_count: cartCount }));
      });

      router.get("/account/orders/:order_id/return", async function (req, res) {
        var auth = _returnsAuth(req, res); if (!auth) return;
        var order = await _ownedOrder(req, res, auth); if (!order) return;
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderReturnForm({ order: order, lines: order.lines || [], shop_name: shopName, cart_count: cartCount }));
      });

      router.post("/account/orders/:order_id/return", async function (req, res) {
        var auth = _returnsAuth(req, res); if (!auth) return;
        var order = await _ownedOrder(req, res, auth); if (!order) return;
        var body = req.body || {};
        var cartCount = await _cartCountForReq(req);
        // Build the return lines from the order's own lines (authoritative
        // sku/qty), keyed by the checkboxes the customer ticked — never
        // trust a client-supplied sku.
        var orderLines = order.lines || [];
        var picked = [];
        for (var i = 0; i < orderLines.length; i += 1) {
          var ol = orderLines[i];
          if (body["return_" + ol.id] !== "1") continue;
          var wanted = parseInt(body["qty_" + ol.id], 10);
          var qty = Number.isFinite(wanted) && wanted >= 1 && wanted <= ol.qty ? wanted : ol.qty;
          picked.push({ order_line_id: ol.id, sku: ol.sku, qty: qty });
        }
        if (picked.length === 0) {
          return _send(res, 400, renderReturnForm({
            order: order, lines: orderLines, notice: "Select at least one item to return.",
            shop_name: shopName, cart_count: cartCount,
          }));
        }
        try {
          await deps.returns.request({
            order_id:       order.id,
            customer_id:    auth.customer_id,
            reason:         body.reason,
            customer_notes: body.customer_notes,
            lines:          picked,
          });
        } catch (e) {
          if (e instanceof TypeError) {
            return _send(res, 400, renderReturnForm({
              order: order, lines: orderLines, notice: (e && e.message) || "Please check your return request.",
              shop_name: shopName, cart_count: cartCount,
            }));
          }
          throw e;
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/returns");
        return res.end ? res.end() : res.send("");
      });
    }

    // Loyalty — the signed-in customer's points balance + tier, the
    // earn/redeem ledger, how points are earned, and (when a reward
    // catalog + redemption primitive are wired) a redeem-a-reward
    // control. Login-gated; a read failure on any optional sub-read
    // degrades that section to empty rather than 500-ing the page.
    if (deps.loyalty) {
      function _loyaltyAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }

      // Build the full /account/loyalty render context for a customer.
      // `opts2.cursor` is the optional history-page cursor (epoch-ms).
      // Each optional read (earn rules, reward catalog, redemptions) is
      // best-effort so a not-migrated table degrades that panel rather
      // than the page.
      async function _loyaltyView(req, auth, opts2) {
        opts2 = opts2 || {};
        var bal = await deps.loyalty.balance(auth.customer_id);
        var hist = await deps.loyalty.history(auth.customer_id, { limit: 20, cursor: opts2.cursor });
        var rules = [];
        if (deps.loyaltyEarnRules) {
          try { rules = await deps.loyaltyEarnRules.listRules({ active_only: true, limit: 50 }); }
          catch (_e) { rules = []; }
        }
        var rewards = [];
        var redemptions = [];
        if (deps.loyaltyRedemption) {
          try { rewards = await deps.loyaltyRedemption.listRewards({ active_only: true, limit: 50 }); }
          catch (_e) { rewards = []; }
          try {
            var rpage = await deps.loyaltyRedemption.redemptionsForCustomer(auth.customer_id, { limit: 20 });
            redemptions = rpage.rows;
          } catch (_e) { redemptions = []; }
        }
        var cartCount = await _cartCountForReq(req);
        return {
          balance:        bal,
          tiers:          deps.loyalty.TIERS,
          tier_thresholds: deps.loyalty.TIER_THRESHOLDS,
          redemption_points_per_usd: deps.loyalty.REDEMPTION_POINTS_PER_USD,
          history:        hist.rows,
          history_next_cursor: hist.next_cursor,
          earn_rules:     rules,
          rewards:        rewards,
          redemptions:    redemptions,
          can_redeem:     !!deps.loyaltyRedemption,
          notice:         opts2.notice || null,
          notice_kind:    opts2.notice_kind || null,
          shop_name:      shopName,
          cart_count:     cartCount,
        };
      }

      router.get("/account/loyalty", async function (req, res) {
        var auth = _loyaltyAuth(req, res); if (!auth) return;
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var cursorRaw = url && url.searchParams.get("cursor");
        var cursor;
        if (cursorRaw != null && cursorRaw !== "") {
          var n = parseInt(cursorRaw, 10);
          // A malformed cursor degrades to the first page (the lib
          // would TypeError on a non-integer) — never 500 the page.
          cursor = Number.isFinite(n) && n >= 0 ? n : undefined;
        }
        var view = await _loyaltyView(req, auth, { cursor: cursor });
        _send(res, 200, renderLoyalty(view));
      });

      // Redeem a reward from the catalog. Mounts only when the
      // redemption primitive is wired. The reward debits points via the
      // composed loyalty ledger; insufficient balance / cap reached /
      // not-redeemable surface as a 400 re-render, never a 500.
      if (deps.loyaltyRedemption) {
        router.post("/account/loyalty/redeem", async function (req, res) {
          var auth = _loyaltyAuth(req, res); if (!auth) return;
          var body = req.body || {};
          var rewardSlug = body.reward_slug;
          try {
            await deps.loyaltyRedemption.redeemForCustomer({
              customer_id: auth.customer_id,
              reward_slug: rewardSlug,
            });
          } catch (e) {
            // Customer-facing refusals (TypeError on a bad slug,
            // LOYALTY_INSUFFICIENT_BALANCE, REWARD_NOT_REDEEMABLE,
            // REDEMPTION_CAP_REACHED) re-render the page with the
            // reason; anything else propagates as a 500.
            var code = (e && typeof e.code === "string") ? e.code : "";
            var clientErr = (e instanceof TypeError)
              || code === "LOYALTY_INSUFFICIENT_BALANCE"
              || code === "REWARD_NOT_REDEEMABLE"
              || code === "REDEMPTION_CAP_REACHED";
            if (!clientErr) throw e;
            var msg;
            if (code === "LOYALTY_INSUFFICIENT_BALANCE") msg = "You don't have enough points for that reward yet.";
            else if (code === "REWARD_NOT_REDEEMABLE")   msg = "That reward isn't available right now.";
            else if (code === "REDEMPTION_CAP_REACHED")  msg = "You've reached the redemption limit for that reward.";
            else                                          msg = "We couldn't redeem that reward — please pick one from the list.";
            var failView = await _loyaltyView(req, auth, { notice: msg, notice_kind: "error" });
            return _send(res, 400, renderLoyalty(failView));
          }
          res.status(303); res.setHeader && res.setHeader("location", "/account/loyalty");
          return res.end ? res.end() : res.send("");
        });
      }
    }

    // Referrals — refer-a-friend. Three surfaces:
    //   * GET  /r/:code            — the attribution landing. Sets a
    //     short-lived sealed first-party cookie naming the code, records
    //     the visit, then 303s home. An unknown / malformed / disabled
    //     code is silently ignored (no cookie, no error to the visitor).
    //     Public — no sign-in. The cookie is read at account-creation to
    //     attribute the new customer to the referrer.
    //   * GET  /account/referrals — the signed-in customer's own code +
    //     shareable link, the friends they've referred (funnel stage,
    //     no PII), and the in-account top-referrer leaderboard.
    //   * POST /account/referrals/code — mint the customer's code (one
    //     active code per customer; idempotent on an existing one).
    // Attribution is FIRST-TOUCH: trackSignup pins the signup to the
    // oldest pending invitation under the code, and the landing only
    // overwrites the cookie when none is already set (below), so the
    // first referral link a visitor follows wins.
    if (deps.referrals) {
      function _referralsAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }

      // The attribution landing. The cookie is path "/" so it survives
      // the visitor's navigation to the register page, sealed so it
      // can't be forged to mis-attribute a signup, and short-lived
      // (30 days) so a stale link doesn't attribute a much-later signup.
      router.get("/r/:code", async function (req, res) {
        function _goHome() {
          res.status(303); res.setHeader && res.setHeader("location", "/");
          return res.end ? res.end() : res.send("");
        }
        var raw = req.params && req.params.code;
        // Resolve the code to a live row. A bad shape throws TypeError
        // inside byCode (canonicalization) — swallow it; the visitor
        // sees a clean redirect home, never an error tied to a guessed
        // code (no code-existence oracle).
        var row;
        try { row = await deps.referrals.byCode(raw); }
        catch (_e) { row = null; }
        if (!row || row.status !== "active") return _goHome();
        // First-touch: don't overwrite an existing referral cookie — the
        // first link the visitor followed keeps the attribution.
        var existing = null;
        try { existing = _readReferralEnv(req); } catch (_e) { existing = null; }
        if (!existing || !existing.code) {
          _setReferralCookie(res, { code: row.code, set_at: Date.now() });
        }
        // Record the visit on the funnel (best-effort — a tracking
        // failure must not block the redirect).
        try { await deps.referrals.trackVisit({ code: row.code }); }
        catch (_e) { /* drop-silent — the visit stat is non-critical */ }
        return _goHome();
      });

      // Build the /account/referrals render context. Each read is
      // best-effort so a not-migrated dependency degrades that panel
      // rather than 500-ing the page.
      async function _referralsView(req, auth, opts2) {
        opts2 = opts2 || {};
        var code = null, link = null;
        var stats = null;
        try { stats = await deps.referrals.statsForReferrer(auth.customer_id); }
        catch (_e) { stats = null; }
        if (stats && stats.codes && stats.codes.length) {
          // Surface the active code (the one the customer shares). Fall
          // back to the newest code row if none is active (all disabled).
          var active = null;
          for (var i = 0; i < stats.codes.length; i += 1) {
            if (stats.codes[i].status === "active") { active = stats.codes[i]; break; }
          }
          var chosen = active || stats.codes[stats.codes.length - 1];
          if (chosen) {
            code = chosen.code;
            link = _referralLink(req, chosen.code);
          }
        }
        var invitations = [];
        try { invitations = await deps.referrals.invitationsForReferrer(auth.customer_id); }
        catch (_e) { invitations = []; }
        var leaderboard = [];
        if (deps.referralLeaderboard) {
          try {
            // Lifetime top referrers. The referrals primitive's own
            // leaderboard returns { referrer_customer_id, completed }; we
            // resolve each to initials for display (rank + initials only,
            // never names/emails/ids), and mark the signed-in customer.
            var top = await deps.referrals.leaderboard({ limit: 10 });
            for (var k = 0; k < top.length; k += 1) {
              var rid = top[k].referrer_customer_id;
              var dn = "";
              try {
                var cust = await deps.customers.get(rid);
                dn = (cust && cust.display_name) || "";
              } catch (_e) { dn = ""; }
              leaderboard.push({
                completed_referrals: top[k].completed_referrals,
                display_name:        dn,
                is_you:              rid === auth.customer_id,
              });
            }
          } catch (_e) { leaderboard = []; }
        }
        var cartCount = await _cartCountForReq(req);
        return {
          code:                  code,
          link:                  link,
          invitations:           invitations,
          leaderboard:           leaderboard,
          completed_referrals:   stats ? stats.completed_referrals : 0,
          invitations_total:     stats ? stats.invitations_total : 0,
          invitations_signed_up: stats ? stats.invitations_signed_up : 0,
          notice:                opts2.notice || null,
          notice_kind:           opts2.notice_kind || null,
          shop_name:             shopName,
          cart_count:            cartCount,
        };
      }

      router.get("/account/referrals", async function (req, res) {
        var auth = _referralsAuth(req, res); if (!auth) return;
        var view = await _referralsView(req, auth, {});
        _send(res, 200, renderReferrals(view));
      });

      router.post("/account/referrals/code", async function (req, res) {
        var auth = _referralsAuth(req, res); if (!auth) return;
        try {
          await deps.referrals.issueCode({ referrer_customer_id: auth.customer_id });
        } catch (e) {
          // An existing active code is the idempotent happy path — the
          // customer already has one, so just show the page. Any other
          // refusal re-renders with a generic notice; never a 500 for a
          // TypeError on the (cookie-derived) customer id.
          var code = (e && typeof e.code === "string") ? e.code : "";
          if (code !== "REFERRAL_CODE_ALREADY_ACTIVE" && !(e instanceof TypeError)) {
            throw e;
          }
          if (code !== "REFERRAL_CODE_ALREADY_ACTIVE") {
            var failView = await _referralsView(req, auth, {
              notice: "We couldn't create your referral code — please try again.",
              notice_kind: "error",
            });
            return _send(res, 400, renderReferrals(failView));
          }
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/referrals");
        return res.end ? res.end() : res.send("");
      });
    }

    // Recently viewed — the signed-in customer's newest-first browse
    // history. Views are recorded server-side on the (container-rendered)
    // PDP; this surface lets the customer review + clear that history.
    if (deps.recentlyViewed) {
      function _rvAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }

      router.get("/account/recently-viewed", async function (req, res) {
        var auth = _rvAuth(req, res); if (!auth) return;
        // A read failure (table not migrated) degrades to the empty
        // state rather than 500-ing the account page.
        var rows = [];
        try { rows = await deps.recentlyViewed.forCustomer(auth.customer_id, { limit: 24 }); }
        catch (_e) { rows = []; }
        var products = [];
        for (var i = 0; i < rows.length; i += 1) {
          var card = await _decorateProductCard(rows[i].product_id);
          if (card) products.push(card);
        }
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderRecentlyViewed({ products: products, shop_name: shopName, cart_count: cartCount }));
      });

      router.post("/account/recently-viewed/clear", async function (req, res) {
        var auth = _rvAuth(req, res); if (!auth) return;
        try { await deps.recentlyViewed.purgeCustomer(auth.customer_id); }
        catch (_e) { /* drop-silent — a failed clear leaves history intact, no error surface needed */ }
        res.status(303); res.setHeader && res.setHeader("location", "/account/recently-viewed");
        return res.end ? res.end() : res.send("");
      });
    }

    // Product reviews — submission requires a logged-in customer AND a
    // verified purchase of the product (the gate, not just a badge).
    // Only mounts when both the reviews primitive and an order handle
    // (for the purchase check) are wired.
    if (deps.reviews && deps.order) {
      async function _reviewGateContext(req, res) {
        var slug = req.params && req.params.slug;
        var product = slug ? await deps.catalog.products.bySlug(slug) : null;
        if (!product) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        var cartCount = await _cartCountForReq(req);
        var purchased = await deps.order.hasPurchasedProduct(auth.customer_id, product.id);
        return { product: product, auth: auth, cartCount: cartCount, purchased: purchased };
      }

      function _reviewIneligible(res, ctx, code) {
        return _send(res, code, _reviewMessagePage(
          { shop_name: shopName, cart_count: ctx.cartCount },
          "Only verified buyers can review",
          "We can only accept a review for a product you've purchased. Make sure you're signed in with the account you ordered with.",
          { href: "/products/" + ctx.product.slug, label: "Back to product" },
        ));
      }

      router.get("/products/:slug/review", async function (req, res) {
        var ctx = await _reviewGateContext(req, res);
        if (!ctx) return;
        if (!ctx.purchased) return _reviewIneligible(res, ctx, 200);
        _send(res, 200, renderReviewForm({
          product:    { title: ctx.product.title, slug: ctx.product.slug },
          shop_name:  shopName,
          cart_count: ctx.cartCount,
        }));
      });

      router.post("/products/:slug/review", async function (req, res) {
        var ctx = await _reviewGateContext(req, res);
        if (!ctx) return;
        // Re-check the gate on write — a client can POST directly
        // without ever fetching the form.
        if (!ctx.purchased) return _reviewIneligible(res, ctx, 403);
        var body = req.body || {};
        try {
          await deps.reviews.submit({
            product_id:        ctx.product.id,
            customer_id:       ctx.auth.customer_id,
            rating:            parseInt(body.rating, 10),
            title:             body.title,
            body:              body.body,
            verified_purchase: 1,
          });
        } catch (e) {
          // Shape rejections bounce back to the form with the reason;
          // anything else is a real 500.
          if (e instanceof TypeError) {
            return _send(res, 400, renderReviewForm({
              product:    { title: ctx.product.title, slug: ctx.product.slug },
              notice:     (e && e.message) || "Please check your review and try again.",
              shop_name:  shopName,
              cart_count: ctx.cartCount,
            }));
          }
          throw e;
        }
        _send(res, 200, _reviewMessagePage(
          { shop_name: shopName, cart_count: ctx.cartCount },
          "Thanks for your review",
          "Your review has been submitted and is pending moderation. It will appear on the product page once an operator approves it.",
          { href: "/products/" + ctx.product.slug, label: "Back to product" },
        ));
      });
    }
  }

  // POST /cart/lines — add a line. Reads variant_id + qty from the
  // form body (b.middleware.bodyParser parses it into req.body).
  // CSRF token validation is the responsibility of the csrfProtect
  // middleware mounted at the app level (server.js). Redirects to
  // /cart on success so a refresh doesn't re-submit the form.
  router.post("/cart/lines", async function (req, res) {
    var body = req.body || {};
    var variantId = body.variant_id;
    var qtyRaw    = body.qty;
    var qty       = parseInt(qtyRaw, 10);
    if (!variantId || !Number.isFinite(qty) || qty < 1 || qty > 99) {
      res.status(400);
      return res.end ? res.end("Invalid request") : res.send("Invalid request");
    }
    var resolved = await _getOrCreateCart(req, res, "USD");
    try {
      await deps.cart.addLine(resolved.cart.id, { variant_id: variantId, qty: qty });
    } catch (e) {
      res.status(e instanceof TypeError ? 400 : 500);
      return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
    }
    res.status(303);
    res.setHeader && res.setHeader("location", "/cart");
    res.end ? res.end() : res.send("");
  });

  // POST /cart/lines/:line_id/update — change qty on an existing
  // line. Form value `qty` is the new quantity (1..99). HTML forms
  // only support GET/POST so the verb is in the path.
  router.post("/cart/lines/:line_id/update", async function (req, res) {
    var lineId = req.params && req.params.line_id;
    var qty    = parseInt((req.body || {}).qty, 10);
    if (!lineId || !Number.isFinite(qty) || qty < 1 || qty > 99) {
      res.status(400);
      return res.end ? res.end("Invalid request") : res.send("Invalid request");
    }
    try {
      var updated = await deps.cart.updateLine(lineId, { qty: qty });
      if (!updated) {
        res.status(404);
        return res.end ? res.end("Line not found") : res.send("Line not found");
      }
    } catch (e) {
      res.status(e instanceof TypeError ? 400 : 500);
      return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
    }
    res.status(303);
    res.setHeader && res.setHeader("location", "/cart");
    res.end ? res.end() : res.send("");
  });

  // POST /cart/lines/:line_id/remove — delete the line outright.
  router.post("/cart/lines/:line_id/remove", async function (req, res) {
    var lineId = req.params && req.params.line_id;
    if (!lineId) {
      res.status(400);
      return res.end ? res.end("Invalid request") : res.send("Invalid request");
    }
    try {
      await deps.cart.removeLine(lineId);
    } catch (e) {
      res.status(e instanceof TypeError ? 400 : 500);
      return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
    }
    res.status(303);
    res.setHeader && res.setHeader("location", "/cart");
    res.end ? res.end() : res.send("");
  });

  // Newsletter signup — POST /newsletter from the footer band.
  // Validates the address through `b.guardEmail`, idempotently
  // enrolls via the newsletter primitive (when wired), and renders
  // a designed thank-you page. Mount only when `deps.newsletter`
  // is present so operators that haven't wired the primitive get
  // a clean 404 instead of a misleading "thanks" response.
  if (deps.newsletter) {
    router.post("/newsletter", async function (req, res) {
      var body = req.body || {};
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
      try {
        var result = await deps.newsletter.signup({
          email:  body.email,
          source: "storefront-footer",
        });
        return _send(res, 200, renderNewsletterThanks({
          shop_name:  shopName,
          cart_count: cartCount,
          status:     result.status,
        }));
      } catch (e) {
        // TypeError == operator-fault validation refusal; everything
        // else (D1 unreachable, vault hiccup) hits the 500 branch.
        var isInputError = e instanceof TypeError;
        return _send(res, isInputError ? 400 : 500, renderNewsletterError({
          shop_name:  shopName,
          cart_count: cartCount,
          message:    isInputError ? "That doesn't look like a valid email address. Check the format and try again." : null,
        }));
      }
    });
  }

  // robots.txt — minimal crawl policy. Allow everything except
  // the admin API + cart + account + checkout / pay / orders (these
  // are session-scoped or operator-only, no crawl value), and
  // point at the sitemap. Operators with stricter requirements
  // replace the file at the same path via R2 (the Worker's
  // static-asset bridge would serve it ahead of this route if a
  // `robots.txt` key exists in the bucket).
  router.get("/robots.txt", function (req, res) {
    res.status(200);
    res.setHeader && res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader && res.setHeader("cache-control", "public, max-age=3600");
    var hostHeader = req.headers && (req.headers.host || req.headers.Host) || "";
    var origin = hostHeader ? ("https://" + hostHeader) : "";
    var body =
      "User-agent: *\n" +
      "Allow: /\n" +
      "Disallow: /admin\n" +
      "Disallow: /cart\n" +
      "Disallow: /checkout\n" +
      "Disallow: /pay/\n" +
      "Disallow: /orders/\n" +
      "Disallow: /account\n" +
      (origin ? ("Sitemap: " + origin + "/sitemap.xml\n") : "");
    res.end ? res.end(body) : res.send(body);
  });

  // sitemap.xml — lists every active product slug + the home page
  // + the framework-API landing. Cached short (5 minutes) so a
  // catalog update propagates without an operator action. The XML
  // is hand-rolled (no node:xml dep) because the surface is
  // ~3 fields per row and the XML-escape is trivial.
  router.get("/sitemap.xml", async function (req, res) {
    // XML 1.0 §4.6 names `&apos;` for apostrophe but also accepts the
    // numeric reference `&#x27;` — which is what b.template.escapeHtml
    // emits, so the same primitive works for the sitemap.
    function _xmlEsc(s) { return b.template.escapeHtml(s); }
    var hostHeader = req.headers && (req.headers.host || req.headers.Host) || "";
    var origin = hostHeader ? ("https://" + hostHeader) : "";
    var urls = [];
    urls.push({ loc: origin + "/",      changefreq: "daily",   priority: "1.0" });
    urls.push({ loc: origin + "/admin", changefreq: "monthly", priority: "0.3" });
    try {
      var page = await deps.catalog.products.list({ status: "active", limit: 1000 });
      for (var i = 0; i < page.rows.length; i += 1) {
        var p = page.rows[i];
        var lastmod = new Date(p.updated_at || p.created_at || Date.now()).toISOString().slice(0, 10);
        urls.push({
          loc:        origin + "/products/" + p.slug,
          lastmod:    lastmod,
          changefreq: "weekly",
          priority:   "0.8",
        });
      }
    } catch (_e) { /* drop-silent — catalog unreachable means sitemap drops product rows */ }
    var body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
               "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n";
    for (var u = 0; u < urls.length; u += 1) {
      var item = urls[u];
      body += "  <url>\n";
      body += "    <loc>" + _xmlEsc(item.loc) + "</loc>\n";
      if (item.lastmod) body += "    <lastmod>" + _xmlEsc(item.lastmod) + "</lastmod>\n";
      body += "    <changefreq>" + _xmlEsc(item.changefreq) + "</changefreq>\n";
      body += "    <priority>" + _xmlEsc(item.priority) + "</priority>\n";
      body += "  </url>\n";
    }
    body += "</urlset>\n";
    res.status(200);
    res.setHeader && res.setHeader("content-type", "application/xml; charset=utf-8");
    res.setHeader && res.setHeader("cache-control", "public, max-age=300");
    res.end ? res.end(body) : res.send(body);
  });

  // Designed admin landing — the rest of /admin/* is JSON. This
  // single GET gives footer links + curious visitors a designed
  // page explaining the API-only posture instead of a 404.
  router.get("/admin", async function (req, res) {
    var cartCount = 0;
    try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
    _send(res, 200, renderAdminLanding({
      shop_name:  shopName,
      cart_count: cartCount,
    }));
  });

  // Catch-all 404 — every unmatched route lands on the designed
  // not-found page (gradient 404 + back-to-shop CTA) inside the
  // standard layout, instead of the framework's default
  // `<h1>404 Not Found</h1>` text body. Wired via the router's
  // onNotFound hook so it covers GET/POST/HEAD uniformly.
  if (typeof router.onNotFound === "function") {
    router.onNotFound(async function (req, res) {
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
      _send(res, 404, renderNotFound({
        shop_name:  shopName,
        cart_count: cartCount,
        theme:      theme,
      }));
    });
  }
}

module.exports = {
  mount:                 mount,
  webhookRawBodyCapture: webhookRawBodyCapture,
  renderHome:            renderHome,
  renderSearch:          renderSearch,
  renderProduct:         renderProduct,
  renderCart:            renderCart,
  renderCheckoutForm:    renderCheckoutForm,
  renderGiftCardBalance: renderGiftCardBalance,
  renderPayPage:         renderPayPage,
  renderOrder:           renderOrder,
  renderAccountLogin:    renderAccountLogin,
  renderAccountRegister: renderAccountRegister,
  renderAccount:         renderAccount,
  renderAccountSubscriptions: renderAccountSubscriptions,
  renderNotFound:        renderNotFound,
  // Layout exposed so operators forking the framework can override.
  _wrap:                 _wrap,
  LAYOUT:                LAYOUT,
};
