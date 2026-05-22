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

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
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
  "  <link rel=\"stylesheet\" href=\"{{theme_css}}\">\n" +
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
// The default theme stylesheet ships from R2 at this path. The
// `?v=` query is a build-time cache-buster — operator uploads to R2
// rewrite the bytes at the same path, and without the version
// param browsers happily serve the previous cached CSS for the
// five-minute default TTL. Bumping this constant on each release
// forces every active session to re-fetch.
var DEFAULT_THEME_CSS_URL = "/assets/themes/default/css/main.css?v=" + require("../package.json").version;

function _wrap(opts) {
  var themeCss = (opts && typeof opts.theme_css === "string" && opts.theme_css.length)
    ? opts.theme_css
    : DEFAULT_THEME_CSS_URL;
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
    year:           String(new Date().getUTCFullYear()),
    search_q:       opts.search_q == null ? "" : opts.search_q,
    theme_css:      themeCss,
    og_type:        ogType,
    og_title:       ogTitle,
    og_description: ogDescription,
    og_image:       ogImage,
    og_url:         ogUrl,
    body:           "RAW_BODY_PLACEHOLDER",
  }).replace("RAW_BODY_PLACEHOLDER", opts.body);
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
  function _esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
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
  "    </div>\n" +
  "  </div>\n" +
  "</section>\n";

// PDP gallery markup — composed once per render call from the
// product's media rows. When media is present, the first row drives
// the main figure (with `alt_text` for a11y) and up to three more
// rows feed the thumbnail strip below it. When media is absent the
// gallery falls back to the existing letter-mark placeholder so a
// freshly-seeded product never renders an empty square.
function _buildPdpGallery(product, media, assetPrefix) {
  var prefix = assetPrefix || "/assets/";
  function _escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
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
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var rows = rendered.map(function (v) {
    return _render(VARIANT_ROW, { title: v.title, sku: v.sku, price: v.price, variant_id: v.id });
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"4\" class=\"empty\">No variants available.</td></tr>";
  var galleryHtml = _buildPdpGallery(opts.product, opts.media || [], opts.asset_prefix || "/assets/");
  var body = _render(PRODUCT_PAGE, {
    title:        opts.product.title,
    description:  description,
    variant_rows: "RAW_ROWS_PLACEHOLDER",
  })
    .replace("RAW_GALLERY_PLACEHOLDER", galleryHtml)
    .replace("RAW_ROWS_PLACEHOLDER", rows);
  // Product-specific OpenGraph + Twitter Card values so shares
  // unfurl as "Operator Tee — blamejs.shop" with the SVG hero, not
  // the default shop-level description + brand logo.
  var heroMedia = (opts.media && opts.media[0]) || null;
  var ogImage   = heroMedia ? ((opts.asset_prefix || "/assets/") + heroMedia.r2_key) : "/assets/brand/logo.png";
  return _wrap({
    title:          opts.product.title,
    shop_name:      shopName,
    cart_count:     cartCount,
    theme_css:      opts.theme_css,
    og_type:        "product",
    og_title:       opts.product.title + " — " + shopName,
    og_description: description || ("Browse " + opts.product.title + " on " + shopName + "."),
    og_image:       ogImage,
    body:           body,
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
  "  <td>{{qty}}</td>\n" +
  "  <td class=\"price\">{{unit}}</td>\n" +
  "  <td class=\"price\">{{total}}</td>\n" +
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
  "  <td class=\"cart-line__qty\">\n" +
  "    <form method=\"post\" action=\"/cart/lines/{{line_id}}/update\" class=\"cart-line__update\">\n" +
  "      <input type=\"number\" name=\"qty\" value=\"{{qty}}\" min=\"1\" max=\"99\" class=\"cart-line__qty-input\" aria-label=\"Quantity\">\n" +
  "      <button type=\"submit\" class=\"cart-line__btn\">Update</button>\n" +
  "    </form>\n" +
  "  </td>\n" +
  "  <td class=\"price\">{{unit}}</td>\n" +
  "  <td class=\"price\">{{total}}</td>\n" +
  "  <td class=\"cart-line__remove-cell\">\n" +
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
  return _wrap({
    title:      "Checkout",
    shop_name:  shopName,
    cart_count: lines.length,
    theme_css: opts.theme_css,
    body:       body,
  });
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
  "    <div id=\"payment-element\" class=\"pay-card__element\"></div>\n" +
  "    <button id=\"submit\" type=\"button\" class=\"btn-primary pay-card__submit\">Pay {{grand_total}}</button>\n" +
  "    <p id=\"payment-message\" class=\"pay-card__message\"></p>\n" +
  "  </div>\n" +
  "  <script src=\"https://js.stripe.com/v3/\"></script>\n" +
  "  <script>\n" +
  "    (function () {\n" +
  "      var stripe = Stripe({{pk_json}});\n" +
  "      var elements = stripe.elements({ clientSecret: {{client_secret_json}}, appearance: { theme: \"stripe\" } });\n" +
  "      var paymentElement = elements.create(\"payment\");\n" +
  "      paymentElement.mount(\"#payment-element\");\n" +
  "      document.getElementById(\"submit\").addEventListener(\"click\", function () {\n" +
  "        document.getElementById(\"payment-message\").textContent = \"Processing...\";\n" +
  "        stripe.confirmPayment({ elements: elements, confirmParams: { return_url: window.location.origin + \"/orders/{{order_id}}\" } }).then(function (result) {\n" +
  "          if (result.error) { document.getElementById(\"payment-message\").textContent = result.error.message || \"Payment failed.\"; }\n" +
  "        });\n" +
  "      });\n" +
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
  "        <table>\n" +
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
  if (opts.theme) {
    return opts.theme.render("order", {
      title:          "Order " + o.id,
      shop_name:      shopName,
      cart_count:     cartCount,
      order_id:       o.id,
      status:         o.status,
      lines:          rendered,
      has_lines:      rendered.length > 0,
      subtotal:       subtotal,
      tax:            tax,
      shipping:       shipping,
      total:          total,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  function _orderEsc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
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
  return _wrap({
    title:      "Order " + o.id,
    shop_name:  shopName,
    cart_count: cartCount,
    theme_css: opts.theme_css,
    body:       body,
  });
}

var CART_PAGE =
  "<section class=\"cart-page\">\n" +
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
  function _escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  var rows = rendered.map(function (l) {
    var thumb = l.image_url
      ? "<span class=\"cart-line__thumb\"><img src=\"" + _escAttr(l.image_url) + "\" alt=\"" + _escAttr(l.image_alt) + "\" loading=\"lazy\"></span>"
      : "<span class=\"cart-line__thumb cart-line__thumb--empty\" aria-hidden=\"true\"></span>";
    return _render(CART_LINE_EDITABLE, {
      sku:            l.sku,
      qty:            l.qty,
      unit:           l.unit,
      total:          l.total,
      line_id:        l.id,
      product_title:  l.product_title,
      product_url:    l.product_url,
    }).replace("RAW_CART_LINE_THUMB", thumb);
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"5\" class=\"empty\">Your cart is empty.</td></tr>";
  var body = _render(CART_PAGE, {
    line_rows: "RAW_LINES",
    subtotal:  subtotal,
    total:     total,
  }).replace("RAW_LINES", rows);
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
var SESSION_COOKIE_MAX  = 60 * 60 * 24 * 30;   // 30 days

// Authenticated-customer cookie — carries an opaque sealed envelope
// `{ customer_id, exp }`, AEAD-encrypted via b.vault.seal so the
// cookie itself has no internal structure visible to a tampering
// network attacker. Cookie name `shop_auth`; HttpOnly + Secure +
// SameSite=Lax + Path=/. The vault key is the deployment's KEK; a
// rotated vault invalidates every outstanding auth cookie (operator-
// initiated logout-everywhere).
var AUTH_COOKIE_NAME    = "shop_auth";
var AUTH_COOKIE_MAX     = 60 * 60 * 24 * 14;       // 14 days
var AUTH_TTL_MS         = 14 * 24 * 60 * 60 * 1000;

// WebAuthn ceremony state cookie — short-lived envelope holding the
// random challenge + the ceremony-scoped metadata so register-finish /
// login-finish can verify the same challenge the browser was sent.
// Path-scoped to /account so it never leaks to other routes.
var CHALLENGE_COOKIE_NAME = "shop_auth_chal";
var CHALLENGE_COOKIE_MAX  = 5 * 60;                // 5 minutes

function _readSidCookie(req) {
  var raw = (req.headers && (req.headers.cookie || req.headers.Cookie)) || "";
  if (!raw) return null;
  var parts = raw.split(";");
  for (var i = 0; i < parts.length; i += 1) {
    var p = parts[i].trim();
    var eq = p.indexOf("=");
    if (eq <= 0) continue;
    if (p.slice(0, eq) === SESSION_COOKIE_NAME) {
      var v = p.slice(eq + 1);
      // Cookie values are URL-encoded.
      try { return decodeURIComponent(v); } catch (_e) { return null; }
    }
  }
  return null;
}

function _setSidCookie(res, sid) {
  var attrs = "Max-Age=" + SESSION_COOKIE_MAX + "; Path=/; HttpOnly; Secure; SameSite=Lax";
  var header = SESSION_COOKIE_NAME + "=" + encodeURIComponent(sid) + "; " + attrs;
  if (typeof res.appendHeader === "function") res.appendHeader("Set-Cookie", header);
  else if (typeof res.setHeader === "function") res.setHeader("Set-Cookie", header);
}

function _readCookie(req, name) {
  var raw = (req.headers && (req.headers.cookie || req.headers.Cookie)) || "";
  if (!raw) return null;
  var parts = raw.split(";");
  for (var i = 0; i < parts.length; i += 1) {
    var p = parts[i].trim();
    var eq = p.indexOf("=");
    if (eq <= 0) continue;
    if (p.slice(0, eq) === name) {
      try { return decodeURIComponent(p.slice(eq + 1)); }
      catch (_e) { return null; }
    }
  }
  return null;
}

function _appendCookie(res, header) {
  if (typeof res.appendHeader === "function") res.appendHeader("Set-Cookie", header);
  else if (typeof res.setHeader === "function") res.setHeader("Set-Cookie", header);
}

function _setAuthCookie(res, sealed) {
  var attrs = "Max-Age=" + AUTH_COOKIE_MAX + "; Path=/; HttpOnly; Secure; SameSite=Lax";
  _appendCookie(res, AUTH_COOKIE_NAME + "=" + encodeURIComponent(sealed) + "; " + attrs);
}

function _clearAuthCookie(res) {
  _appendCookie(res,
    AUTH_COOKIE_NAME + "=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
}

function _setChallengeCookie(res, sealed) {
  var attrs = "Max-Age=" + CHALLENGE_COOKIE_MAX + "; Path=/account; HttpOnly; Secure; SameSite=Lax";
  _appendCookie(res, CHALLENGE_COOKIE_NAME + "=" + encodeURIComponent(sealed) + "; " + attrs);
}

function _clearChallengeCookie(res) {
  _appendCookie(res,
    CHALLENGE_COOKIE_NAME + "=; Max-Age=0; Path=/account; HttpOnly; Secure; SameSite=Lax");
}

// ---- account-page renderers --------------------------------------------

var ACCOUNT_LOGIN_PAGE =
  "<section class=\"auth-page\">\n" +
  "  <div class=\"auth-card\">\n" +
  "    <p class=\"eyebrow\">Sign in</p>\n" +
  "    <h1 class=\"auth-card__title\">Welcome back</h1>\n" +
  "    <p class=\"auth-card__lede\">Enter your email and authenticate with your passkey. No password to type, no recovery email to click.</p>\n" +
  "    <form id=\"login-form\" method=\"post\" class=\"form-stack auth-form\">\n" +
  "      <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Email</span><input type=\"email\" name=\"email\" id=\"email\" required autocomplete=\"email\" autofocus></label></div>\n" +
  "      <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary auth-form__submit\">Sign in with passkey</button></div>\n" +
  "      <p id=\"login-message\" class=\"auth-form__message\"></p>\n" +
  "    </form>\n" +
  "    <p class=\"auth-card__alt\">New here? <a href=\"/account/register\">Create an account →</a></p>\n" +
  "  </div>\n" +
  "  <script>\n" +
  "  (function () {\n" +
  "    function _b64uToBuf(s){ s = s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; var raw=atob(s); var arr=new Uint8Array(raw.length); for(var i=0;i<raw.length;i++)arr[i]=raw.charCodeAt(i); return arr.buffer; }\n" +
  "    function _bufToB64u(buf){ var b=new Uint8Array(buf), s=''; for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]); return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); }\n" +
  "    var form=document.getElementById('login-form');\n" +
  "    var msg=document.getElementById('login-message');\n" +
  "    form.addEventListener('submit', async function(ev){\n" +
  "      ev.preventDefault(); msg.textContent='Requesting challenge...';\n" +
  "      try {\n" +
  "        var beginR = await fetch('/account/passkey/login-begin', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body: JSON.stringify({ email: document.getElementById('email').value }) });\n" +
  "        if (!beginR.ok) { msg.textContent = 'Sign-in unavailable.'; return; }\n" +
  "        var options = await beginR.json();\n" +
  "        options.challenge = _b64uToBuf(options.challenge);\n" +
  "        if (options.allowCredentials) options.allowCredentials = options.allowCredentials.map(function(c){ return Object.assign({}, c, { id: _b64uToBuf(c.id) }); });\n" +
  "        var assertion = await navigator.credentials.get({ publicKey: options });\n" +
  "        var payload = { id: assertion.id, rawId: _bufToB64u(assertion.rawId), type: assertion.type, response: { authenticatorData: _bufToB64u(assertion.response.authenticatorData), clientDataJSON: _bufToB64u(assertion.response.clientDataJSON), signature: _bufToB64u(assertion.response.signature), userHandle: assertion.response.userHandle ? _bufToB64u(assertion.response.userHandle) : null } };\n" +
  "        var finishR = await fetch('/account/passkey/login-finish', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });\n" +
  "        if (finishR.ok) { window.location.href = '/account'; } else { msg.textContent = 'Sign-in failed.'; }\n" +
  "      } catch (e) { msg.textContent = (e && e.message) || 'Sign-in error.'; }\n" +
  "    });\n" +
  "  })();\n" +
  "  </script>\n" +
  "</section>\n";

function renderAccountLogin(opts) {
  opts = opts || {};
  return _wrap({
    title:      "Sign in",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css: opts.theme_css,
    body:       ACCOUNT_LOGIN_PAGE,
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
  "  <script>\n" +
  "  (function () {\n" +
  "    function _b64uToBuf(s){ s = s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; var raw=atob(s); var arr=new Uint8Array(raw.length); for(var i=0;i<raw.length;i++)arr[i]=raw.charCodeAt(i); return arr.buffer; }\n" +
  "    function _bufToB64u(buf){ var b=new Uint8Array(buf), s=''; for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]); return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); }\n" +
  "    var form=document.getElementById('reg-form');\n" +
  "    var msg=document.getElementById('reg-message');\n" +
  "    form.addEventListener('submit', async function(ev){\n" +
  "      ev.preventDefault(); msg.textContent='Creating account...';\n" +
  "      try {\n" +
  "        var beginR = await fetch('/account/passkey/register-begin', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body: JSON.stringify({ email: document.getElementById('email').value, display_name: document.getElementById('display_name').value }) });\n" +
  "        if (!beginR.ok) { msg.textContent = (await beginR.text()) || 'Registration unavailable.'; return; }\n" +
  "        var options = await beginR.json();\n" +
  "        options.challenge = _b64uToBuf(options.challenge);\n" +
  "        options.user.id   = _b64uToBuf(options.user.id);\n" +
  "        if (options.excludeCredentials) options.excludeCredentials = options.excludeCredentials.map(function(c){ return Object.assign({}, c, { id: _b64uToBuf(c.id) }); });\n" +
  "        var att = await navigator.credentials.create({ publicKey: options });\n" +
  "        var payload = { id: att.id, rawId: _bufToB64u(att.rawId), type: att.type, response: { attestationObject: _bufToB64u(att.response.attestationObject), clientDataJSON: _bufToB64u(att.response.clientDataJSON), transports: att.response.getTransports ? att.response.getTransports() : [] } };\n" +
  "        var finishR = await fetch('/account/passkey/register-finish', { method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });\n" +
  "        if (finishR.ok) { window.location.href = '/account'; } else { msg.textContent = (await finishR.text()) || 'Enrollment failed.'; }\n" +
  "      } catch (e) { msg.textContent = (e && e.message) || 'Registration error.'; }\n" +
  "    });\n" +
  "  })();\n" +
  "  </script>\n" +
  "</section>\n";

function renderAccountRegister(opts) {
  opts = opts || {};
  return _wrap({
    title:      "Create account",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css: opts.theme_css,
    body:       ACCOUNT_REGISTER_PAGE,
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
  "    <form method=\"post\" action=\"/account/logout\"><button type=\"submit\" class=\"btn-ghost\">Sign out</button></form>\n" +
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
  "  <td><a href=\"/orders/{{order_id}}\" class=\"account-order__id\"><code>{{order_id_short}}</code></a></td>\n" +
  "  <td class=\"account-order__items\">RAW_ACCOUNT_ORDER_THUMBS</td>\n" +
  "  <td><span class=\"pdp__badge {{status_class}}\">{{status}}</span></td>\n" +
  "  <td class=\"price\">{{total}}</td>\n" +
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
  function _escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

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

  function _send(res, status, html) {
    res.status(status);
    res.setHeader && res.setHeader("content-type", "text/html; charset=utf-8");
    res.end ? res.end(html) : res.send(html);
  }

  // Cart-count read shared across every handler that wraps a page in
  // the layout — the header's cart pill renders the count. Returns 0
  // for visitors with no session cookie. Defined at the top of mount
  // so the /admin landing + the onNotFound 404 handler (mounted
  // outside the `if (deps.customers)` block below) can reach it.
  async function _cartCountForReq(req) {
    var sid = _readCookie(req, SESSION_COOKIE_NAME);
    if (!sid) return 0;
    var c = await deps.cart.bySession(sid);
    if (!c) return 0;
    var lines = await deps.cart.listLines(c.id);
    return lines.length;
  }

  // Resolve the cart for this request — read session_id from the
  // sealed cookie, create one (and the cart) if absent. Returns
  // the cart row OR null when the cart was just created (caller can
  // use { sid, cart: null } to skip lookup).
  async function _getOrCreateCart(req, res, currency) {
    var sid = _readSidCookie(req);
    if (!sid) {
      sid = _b().uuid.v7();
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
    var html = renderProduct({
      product:    product,
      variants:   variants,
      prices:     prices,
      media:      media,
      shop_name:  shopName,
      cart_count: cartCount,
      theme:      theme,
    });
    _send(res, 200, html);
  });

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
      _send(res, 200, renderCheckoutForm({ lines: lines, totals: totals, shop_name: shopName, theme: theme }));
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
          idempotency_key:      "checkout:" + c.id + ":" + _b().uuid.v7(),
        });
        // Set a short-lived pay cookie so /pay/:order_id can serve the
        // client_secret without re-running confirm.
        var payCookie = "shop_pay=" + encodeURIComponent(result.payment_intent.client_secret) +
          "; Max-Age=900; Path=/pay/; HttpOnly; Secure; SameSite=Strict";
        if (res.appendHeader)      res.appendHeader("Set-Cookie", payCookie);
        else if (res.setHeader)    res.setHeader("Set-Cookie", payCookie);
        res.status(303);
        res.setHeader && res.setHeader("location", "/pay/" + result.order.id);
        return res.end ? res.end() : res.send("");
      } catch (e) {
        res.status(e instanceof TypeError ? 400 : 500);
        var msg = (e && e.message) || "checkout failed";
        return res.end ? res.end(msg) : res.send(msg);
      }
    });

    router.get("/pay/:order_id", async function (req, res) {
      var orderId = req.params && req.params.order_id;
      if (!orderId) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      var o = await deps.order.get(orderId);
      if (!o) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      // Read the client_secret from the shop_pay cookie set on POST
      // /checkout. The cookie is scoped Path=/pay/ + SameSite=Strict
      // so it's only sent to the pay route and never cross-origin.
      var rawCookies = (req.headers && (req.headers.cookie || req.headers.Cookie)) || "";
      var clientSecret = null;
      rawCookies.split(";").forEach(function (p) {
        var t = p.trim();
        if (t.indexOf("shop_pay=") === 0) {
          try { clientSecret = decodeURIComponent(t.slice("shop_pay=".length)); } catch (_e) { /* drop */ }
        }
      });
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
      _send(res, 200, renderOrder({
        order:          o,
        product_lookup: productLookup,
        shop_name:      shopName,
        theme:          theme,
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
      // Node Buffer / Uint8Array -> base64url string
      var b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    function _sealEnvelope(obj) {
      return _b().vault.seal(JSON.stringify(obj));
    }
    function _unsealEnvelope(s) {
      try {
        var raw = _b().vault.unseal(s);
        return JSON.parse(raw);
      } catch (_e) { return null; }
    }

    function _currentCustomer(req) {
      var raw = _readCookie(req, AUTH_COOKIE_NAME);
      if (!raw) return null;
      var env = _unsealEnvelope(raw);
      if (!env || !env.customer_id || !env.exp) return null;
      if (env.exp < Date.now()) return null;
      return env;
    }

    function _serviceUnavailable(res, msg) {
      res.status(503);
      return res.end ? res.end(msg) : res.send(msg);
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
      _send(res, 200, renderAccountLogin({ shop_name: shopName, cart_count: cartCount }));
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
        var startOpts = await _b().auth.passkey.startRegistration({
          rpName:           rpName,
          rpId:             rpId,
          userName:         customer.email_hash.slice(0, 16),
          userDisplayName:  customer.display_name,
          attestationType:  "none",
        });
        // Seal the ceremony state (challenge + customer_id) into the
        // shop_auth_chal cookie so register-finish verifies against
        // the same challenge without server-side state.
        var sealed = _sealEnvelope({
          kind:           "register",
          customer_id:    customer.id,
          challenge:      startOpts.challenge,
          created_at:     Date.now(),
        });
        _setChallengeCookie(res, sealed);
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
        var rawCookie = _readCookie(req, CHALLENGE_COOKIE_NAME);
        if (!rawCookie) { res.status(400); return res.end ? res.end("missing challenge") : res.send("missing challenge"); }
        var env = _unsealEnvelope(rawCookie);
        if (!env || env.kind !== "register") {
          res.status(400); return res.end ? res.end("bad challenge") : res.send("bad challenge");
        }
        var att = _readJsonBody(req);
        var rv = await _b().auth.passkey.verifyRegistration({
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
        _setAuthCookie(res, _sealEnvelope({
          customer_id: env.customer_id,
          exp:         Date.now() + AUTH_TTL_MS,
        }));
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
        var startOpts = await _b().auth.passkey.startAuthentication({
          rpId:                 rpId,
          allowCredentials:     allow,
          userVerification:     "preferred",
        });
        var sealed = _sealEnvelope({
          kind:        "login",
          email_hash:  hash,
          challenge:   startOpts.challenge,
          created_at:  Date.now(),
        });
        _setChallengeCookie(res, sealed);
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
        var rawCookie = _readCookie(req, CHALLENGE_COOKIE_NAME);
        if (!rawCookie) { res.status(400); return res.end ? res.end("missing challenge") : res.send("missing challenge"); }
        var env = _unsealEnvelope(rawCookie);
        if (!env || env.kind !== "login") { res.status(400); return res.end ? res.end("bad challenge") : res.send("bad challenge"); }
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
        var rv = await _b().auth.passkey.verifyAuthentication({
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
        var sid = _readCookie(req, SESSION_COOKIE_NAME);
        if (sid) {
          try {
            var anonCart = await deps.cart.bySession(sid);
            if (anonCart) await deps.cart.setCustomer(anonCart.id, customer.id);
          } catch (_e) { /* best-effort merge; sign-in itself succeeds */ }
        }
        _clearChallengeCookie(res);
        _setAuthCookie(res, _sealEnvelope({
          customer_id: customer.id,
          exp:         Date.now() + AUTH_TTL_MS,
        }));
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
    function _xmlEsc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    }
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
  renderHome:            renderHome,
  renderSearch:          renderSearch,
  renderProduct:         renderProduct,
  renderCart:            renderCart,
  renderCheckoutForm:    renderCheckoutForm,
  renderPayPage:         renderPayPage,
  renderOrder:           renderOrder,
  renderAccountLogin:    renderAccountLogin,
  renderAccountRegister: renderAccountRegister,
  renderAccount:         renderAccount,
  renderNotFound:        renderNotFound,
  // Layout exposed so operators forking the framework can override.
  _wrap:                 _wrap,
  LAYOUT:                LAYOUT,
};
