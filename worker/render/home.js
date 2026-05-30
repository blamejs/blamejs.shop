import { renderTemplate, escapeHtml, jsonLdScript, assetUrl, stylesheetIntegrityAttr, CONSENT_BANNER, consentScriptTag, cartCountScriptTag, announcementBar, announcementScriptTag, makeFormatPrice, currencySwitcher } from "./_lib.js";
import { resolveChrome, dirFor, localizeLayout } from "./chrome-i18n.js";

var LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"{{lang}}\" dir=\"{{dir}}\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <title>{{title}} — {{shop_name}}</title>\n" +
  "  <meta name=\"description\" content=\"{{og_description}}\">\n" +
  "  <link rel=\"canonical\" href=\"{{canonical_url}}\">\n" +
  "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"/assets/brand/favicon.svg\">\n" +
  "  <link rel=\"icon\" type=\"image/png\" href=\"/assets/brand/favicon.png\">\n" +
  "  <link rel=\"apple-touch-icon\" href=\"/assets/brand/favicon.png\">\n" +
  "  <meta name=\"theme-color\" content=\"#08080a\">\n" +
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
  "  <a class=\"skip-link\" href=\"#main\">{{skip_to_content}}</a>\n" +
  "RAW_ANNOUNCEMENT_BAR" +
  "\n" +
  "  <div class=\"utility-bar\" role=\"complementary\">\n" +
  "    <div class=\"utility-bar__inner\">\n" +
  "      <span class=\"utility-bar__pill\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> {{util_pill}}</span>\n" +
  "      <span class=\"utility-bar__msg\">{{util_msg}}</span>\n" +
  "      <a class=\"utility-bar__link\" href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">{{util_star}}</a>\n" +
  "    </div>\n" +
  "  </div>\n" +
  "\n" +
  "  <header class=\"site-header\">\n" +
  "    <div class=\"site-header__inner\">\n" +
  "      <a href=\"/\" class=\"brand\" aria-label=\"{{shop_name}}\"><img src=\"/assets/brand/logo.png\" alt=\"{{shop_name}}\"></a>\n" +
  "      <form class=\"site-search\" action=\"/search\" method=\"get\" role=\"search\">\n" +
  "        <div class=\"site-search__inner\">\n" +
  "          <label for=\"site-search-q\" class=\"skip-link\">{{search_label}}</label>\n" +
  "          <svg class=\"site-search__icon\" viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M21 21l-4.35-4.35M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\"/></svg>\n" +
  "          <input id=\"site-search-q\" type=\"search\" name=\"q\" value=\"{{search_q}}\" placeholder=\"{{search_placeholder}}\" autocomplete=\"off\" spellcheck=\"false\" maxlength=\"200\">\n" +
  "          <button type=\"submit\">{{search_submit}}</button>\n" +
  "        </div>\n" +
  "      </form>\n" +
  "      <nav class=\"site-nav\" aria-label=\"Primary\">\n" +
  "        <a class=\"site-nav__link\" href=\"/\">{{nav_shop}}</a>\n" +
  "        <a class=\"site-nav__link\" href=\"/#framework\">{{nav_framework}}</a>\n" +
  "        <a class=\"site-nav__icon\" href=\"/account\" aria-label=\"{{nav_account}}\"><svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" aria-hidden=\"true\"><path d=\"M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\"/></svg></a>\n" +
  "        <a class=\"cart-pill\" href=\"/cart\" aria-label=\"{{nav_cart_aria}}\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M3 4h2l2.4 12.1a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 1.95-1.55L21 8H6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><circle cx=\"10\" cy=\"21\" r=\"1.4\" fill=\"currentColor\"/><circle cx=\"17\" cy=\"21\" r=\"1.4\" fill=\"currentColor\"/></svg><span class=\"cart-pill__count\">{{cart_count}}</span></a>\n" +
  "      </nav>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "\n" +
  "  <main id=\"main\">{{body}}</main>\n" +
  "\n" +
  "  <section class=\"newsletter-band\" aria-labelledby=\"newsletter-title\">\n" +
  "    <div class=\"newsletter-band__inner\">\n" +
  "      <div class=\"newsletter-band__copy\">\n" +
  "        <p class=\"eyebrow eyebrow--on-dark\">{{newsletter_eyebrow}}</p>\n" +
  "        <h2 id=\"newsletter-title\">{{newsletter_title}}</h2>\n" +
  "        <p class=\"newsletter-band__lede\">{{newsletter_lede}}</p>\n" +
  "      </div>\n" +
  "      <form class=\"newsletter-band__form\" method=\"post\" action=\"/newsletter\">\n" +
  "        <label class=\"skip-link\" for=\"newsletter-email\">{{newsletter_email}}</label>\n" +
  "        <input id=\"newsletter-email\" type=\"email\" name=\"email\" required placeholder=\"you@example.com\" autocomplete=\"email\">\n" +
  "        <button type=\"submit\">{{newsletter_submit}}</button>\n" +
  "      </form>\n" +
  "    </div>\n" +
  "  </section>\n" +
  "\n" +
  "  <footer class=\"site-footer\">\n" +
  "    <div class=\"site-footer__inner\">\n" +
  "      <div class=\"site-footer__brand-col\">\n" +
  "        <img class=\"site-footer__logo\" src=\"/assets/brand/logo.png\" alt=\"{{shop_name}}\">\n" +
  "        <p class=\"site-footer__tagline\">{{footer_tagline}}</p>\n" +
  "        <ul class=\"site-footer__social\" aria-label=\"Project links\">\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\" aria-label=\"GitHub\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.4-1.3-1.8-1.3-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11 11 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.3v3.4c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z\" fill=\"currentColor\"/></svg></a></li>\n" +
  "          <li><a href=\"https://npmjs.com/package/blamejs\" rel=\"noopener\" aria-label=\"npm\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M2 7v10h6v-7h3v7h11V7H2Zm15 8h-2v-5h-3v5h-1V9h6v6Z\" fill=\"currentColor\"/></svg></a></li>\n" +
  "          <li><a href=\"/feed.xml\" aria-label=\"RSS feed\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M5 4v3a13 13 0 0 1 13 13h3A16 16 0 0 0 5 4Zm0 6v3a7 7 0 0 1 7 7h3a10 10 0 0 0-10-10Zm1 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z\" fill=\"currentColor\"/></svg></a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h2>{{footer_shop_heading}}</h2>\n" +
  "        <ul>\n" +
  "          <li><a href=\"/\">{{footer_shop_all}}</a></li>\n" +
  "          <li><a href=\"/collections\">{{footer_shop_collections}}</a></li>\n" +
  "          <li><a href=\"/categories\">{{footer_shop_categories}}</a></li>\n" +
  "          <li><a href=\"/?sort=new\">{{footer_shop_new}}</a></li>\n" +
  "          <li><a href=\"/?sort=sale\">{{footer_shop_sale}}</a></li>\n" +
  "          <li><a href=\"/compare\">{{footer_shop_compare}}</a></li>\n" +
  "          <li><a href=\"/cart\">{{footer_shop_cart}}</a></li>\n" +
  "          <li><a href=\"/terms\">{{footer_shop_shipping}}</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h2>{{footer_framework_heading}}</h2>\n" +
  "        <ul>\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">{{footer_framework_source}}</a></li>\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs\" rel=\"noopener\">{{footer_framework_core}}</a></li>\n" +
  "          <li><a href=\"/SECURITY.md\">{{footer_framework_security}}</a></li>\n" +
  "          <li><a href=\"/CHANGELOG.md\">{{footer_framework_changelog}}</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h2>{{footer_operators_heading}}</h2>\n" +
  "        <ul>\n" +
  "          <li><a href=\"/account\">{{footer_operators_account}}</a></li>\n" +
  "          <li><a href=\"/orders\">{{footer_operators_orders}}</a></li>\n" +
  "          <li><a href=\"mailto:hello@blamejs.shop\">{{footer_operators_contact}}</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "    </div>\n" +
  "    RAW_CURRENCY_SWITCHER\n" +
  "    RAW_LOCALE_SWITCHER\n" +
  "    <div class=\"site-footer__copy\">\n" +
  "      <p>&copy; {{year}} {{shop_name}} — {{footer_copy_suffix}}</p>\n" +
  "      <ul>\n" +
  "        <li><a href=\"/SECURITY.md\">{{footer_legal_security}}</a></li>\n" +
  "        <li><a href=\"/privacy\">{{footer_legal_privacy}}</a></li>\n" +
  "        <li><a href=\"/terms\">{{footer_legal_terms}}</a></li>\n" +
  "        <li><a href=\"/cookies\">{{footer_legal_cookies}}</a></li>\n" +
  "      </ul>\n" +
  "    </div>\n" +
  "  </footer>\n" +
  CONSENT_BANNER +
  "RAW_CONSENT_SCRIPT" +
  "RAW_CART_COUNT_SCRIPT" +
  "RAW_ANNOUNCEMENT_SCRIPT" +
  "</body>\n" +
  "</html>\n";

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
  "<a class=\"product-card\" href=\"/products/{{slug}}\">\n" +
  "  <figure class=\"product-card__media product-card__media--placeholder\">\n" +
  "    <svg class=\"media-ph__svg\" viewBox=\"0 0 160 120\" aria-hidden=\"true\"><rect width=\"160\" height=\"120\" fill=\"none\"/><g stroke=\"currentColor\" stroke-opacity=\"0.18\" stroke-width=\"1\"><path d=\"M0 30 H160 M0 60 H160 M0 90 H160 M40 0 V120 M80 0 V120 M120 0 V120\"/></g><g fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M80 38 L104 50 L104 76 L80 88 L56 76 L56 50 Z\"/><path d=\"M56 50 L80 62 L104 50 M80 62 V88\" stroke=\"#C75BE8\"/><path d=\"M70 47 L74 50 L70 53\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M77 54 H86\" stroke=\"currentColor\" stroke-width=\"2\"/></g><text x=\"80\" y=\"106\" text-anchor=\"middle\" font-family=\"ui-monospace,Menlo,Consolas,monospace\" font-size=\"9\" letter-spacing=\"1.5\" fill=\"#9b9ba7\">no image yet</text></svg>\n" +
  "  </figure>\n" +
  "  <div class=\"product-card__meta\">\n" +
  "    <h3 class=\"product-card__title\">{{title}}</h3>\n" +
  "    <p class=\"product-card__price\">{{price}}</p>\n" +
  "  </div>\n" +
  "</a>\n";

function _buildProductCard(p) {
  if (p.image_url) {
    return renderTemplate(PRODUCT_CARD_IMAGE, {
      title:     p.title,
      price:     p.price,
      slug:      p.slug,
      image_url: p.image_url,
      image_alt: p.image_alt || p.title,
    });
  }
  return renderTemplate(PRODUCT_CARD, {
    title: p.title,
    price: p.price,
    slug:  p.slug,
  });
}

function _buildHomeHero(version) {
  return "<section class=\"hero hero--dark\">\n" +
    "  <div class=\"hero__bg\" aria-hidden=\"true\">\n" +
    "    <div class=\"hero__grid\"></div>\n" +
    "    <div class=\"hero__glow hero__glow--1\"></div>\n" +
    "    <div class=\"hero__glow hero__glow--2\"></div>\n" +
    "  </div>\n" +
    "  <div class=\"hero__inner\">\n" +
    "    <div class=\"hero__copy\">\n" +
    "      <p class=\"eyebrow eyebrow--on-dark\">~/blamejs.shop — secure commerce · v" + escapeHtml(version) + "</p>\n" +
    "      <h1 class=\"hero__title\">Sell anything.<br>Trust <span class=\"glitch glitch--live\" data-text=\"nothing.\">nothing.</span><span class=\"term-cursor\" aria-hidden=\"true\"></span></h1>\n" +
    "      <p class=\"hero__lede\">An open-source, server-rendered ecommerce framework with post-quantum cryptography baked into every session, cart, and checkout. No client-side validation theater. No npm runtime dependencies. Just hardened HTML.</p>\n" +
    "      <div class=\"hero__cta\">\n" +
    "        <a href=\"#catalog\" class=\"btn-primary\">$ npx create-shop</a>\n" +
    "        <a href=\"https://github.com/blamejs/blamejs.shop\" class=\"btn-ghost btn-ghost--on-dark\" rel=\"noopener\">Read the threat model</a>\n" +
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
    "      <div class=\"collection-card__art collection-card__art--1\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M70 38 C74 44 86 44 90 38 L104 44 L112 58 L100 64 L96 58 L96 92 L64 92 L64 58 L60 64 L48 58 L56 44 Z\"/><path d=\"M71 40 C75 47 85 47 89 40\" stroke=\"#732A8D\" stroke-width=\"2\"/><path d=\"M73 76 H87\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-dasharray=\"2 3\"/></svg></div>\n" +
    "      <div class=\"collection-card__meta\">\n" +
    "        <h3>Apparel</h3>\n" +
    "        <p>Sized, colored, inventoried.</p>\n" +
    "      </div>\n" +
    "    </a>\n" +
    "    <a class=\"collection-card\" href=\"/search?q=edge\">\n" +
    "      <div class=\"collection-card__art collection-card__art--2\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"58\" y=\"38\" width=\"44\" height=\"44\" rx=\"4\"/><rect x=\"70\" y=\"50\" width=\"20\" height=\"20\" rx=\"2\" stroke=\"#732A8D\"/><circle cx=\"80\" cy=\"60\" r=\"3\" fill=\"#AD38DB\" stroke=\"none\"/><path d=\"M66 38 V30 M76 38 V30 M86 38 V30 M96 38 V30\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M66 82 V90 M76 82 V90 M86 82 V90 M96 82 V90\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M58 48 H50 M58 60 H50 M58 72 H50\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M102 48 H110 M102 60 H110 M102 72 H110\" stroke=\"currentColor\" stroke-width=\"2\"/></svg></div>\n" +
    "      <div class=\"collection-card__meta\">\n" +
    "        <h3>Hardware</h3>\n" +
    "        <p>Serialized, warranty-tracked.</p>\n" +
    "      </div>\n" +
    "    </a>\n" +
    "    <a class=\"collection-card\" href=\"/search?q=license\">\n" +
    "      <div class=\"collection-card__art collection-card__art--3\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M60 74 C50 74 48 62 57 59 C56 47 73 43 79 53 C88 47 100 54 97 64 C107 65 107 74 99 74 Z\" stroke=\"#732A8D\"/><path d=\"M78 60 V86\"/><path d=\"M70 78 L78 88 L86 78\"/><path d=\"M64 98 H92\" stroke=\"currentColor\" stroke-width=\"2\"/></svg></div>\n" +
    "      <div class=\"collection-card__meta\">\n" +
    "        <h3>Digital</h3>\n" +
    "        <p>License-key fulfillment.</p>\n" +
    "      </div>\n" +
    "    </a>\n" +
    "    <a class=\"collection-card\" href=\"/search?q=subscription\">\n" +
    "      <div class=\"collection-card__art collection-card__art--4\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M56 50 A26 26 0 0 1 104 56\"/><path d=\"M104 70 A26 26 0 0 1 56 64\"/><path d=\"M104 42 L106 57 L91 55\" stroke=\"#AD38DB\"/><path d=\"M56 78 L54 63 L69 65\" stroke=\"#AD38DB\"/><circle cx=\"80\" cy=\"60\" r=\"6\" stroke=\"#732A8D\"/><circle cx=\"80\" cy=\"60\" r=\"1.6\" fill=\"currentColor\" stroke=\"none\"/></svg></div>\n" +
    "      <div class=\"collection-card__meta\">\n" +
    "        <h3>Subscriptions</h3>\n" +
    "        <p>Stripe-backed recurring.</p>\n" +
    "      </div>\n" +
    "    </a>\n" +
    "    <a class=\"collection-card\" href=\"/search?q=bundle\">\n" +
    "      <div class=\"collection-card__art collection-card__art--5\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M86 36 L106 44 L106 64 L86 72 L66 64 L66 44 Z\" stroke=\"#732A8D\"/><path d=\"M66 44 L86 52 L106 44 M86 52 V72\" stroke=\"#732A8D\"/><path d=\"M70 56 L90 64 L90 88 L70 96 L50 88 L50 64 Z\"/><path d=\"M50 64 L70 72 L90 64 M70 72 V96\"/><path d=\"M70 72 V96\" stroke=\"currentColor\" stroke-width=\"2\"/></svg></div>\n" +
    "      <div class=\"collection-card__meta\">\n" +
    "        <h3>Bundles</h3>\n" +
    "        <p>Composite SKUs, atomic stock.</p>\n" +
    "      </div>\n" +
    "    </a>\n" +
    "    <a class=\"collection-card\" href=\"/search?q=gift\">\n" +
    "      <div class=\"collection-card__art collection-card__art--6\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"48\" y=\"48\" width=\"64\" height=\"42\" rx=\"6\"/><path d=\"M80 48 V90\" stroke=\"#732A8D\"/><path d=\"M80 48 C71 36 56 39 62 49 C57 52 61 57 71 53 C76 51 80 50 80 48 Z\"/><path d=\"M80 48 C89 36 104 39 98 49 C103 52 99 57 89 53 C84 51 80 50 80 48 Z\"/><circle cx=\"80\" cy=\"48\" r=\"2.4\" fill=\"#AD38DB\" stroke=\"none\"/><rect x=\"56\" y=\"70\" width=\"11\" height=\"8\" rx=\"1.6\" stroke=\"currentColor\" stroke-width=\"1.8\"/></svg></div>\n" +
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
}

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

// Fill the chrome placeholders + lang/dir + (empty) switcher into the
// LAYOUT for the resolved locale, leaving the non-chrome `{{...}}` and
// the `RAW_*` splices for the renderTemplate / replace passes below.
// The edge serves the default locale (any explicit choice bypasses the
// edge to the container), so `locale` defaults to the configured
// default and the switcher is empty here. Mirrors the container's
// `_wrap` chrome handling so a given locale yields identical markup.
function _localizeLayout(opts) {
  var locale = opts.locale || opts.default_locale || "en";
  var defaultLocale = opts.default_locale || "en";
  var chrome = resolveChrome(locale, { defaultLocale: defaultLocale, overrides: opts.chrome_overrides || {} });
  return localizeLayout(LAYOUT, {
    chrome:       chrome,
    lang:         locale,
    dir:          dirFor(locale),
    cartCount:    opts.cart_count == null ? 0 : opts.cart_count,
    switcherHtml: "",
  });
}

function _wrap(opts) {
  var themeCss = (typeof opts.theme_css === "string" && opts.theme_css.length)
    ? opts.theme_css
    : assetUrl("css/main.css");
  var shopName = opts.shop_name || "blamejs.shop";
  var ogType        = opts.og_type        || "website";
  var ogTitle       = opts.og_title       || (opts.title ? opts.title + " — " + shopName : shopName);
  var ogDescription = opts.og_description || "Open-source ecommerce framework built on blamejs. Server-rendered HTML, post-quantum crypto, zero npm runtime dependencies.";
  var ogImage       = opts.og_image       || "/assets/brand/logo.png";
  var canonicalUrl  = opts.canonical_url   || "";
  var ogUrl         = opts.og_url          || canonicalUrl;
  var localized = _localizeLayout(opts);
  return renderTemplate(localized, {
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
    canonical_url:  canonicalUrl,
    body:           "RAW_BODY_PLACEHOLDER",
  }).replace("RAW_CSS_INTEGRITY", stylesheetIntegrityAttr(themeCss))
    .replace("RAW_ANNOUNCEMENT_BAR", announcementBar(opts.announcement || null))
    .replace("RAW_CONSENT_SCRIPT", consentScriptTag())
    .replace("RAW_CART_COUNT_SCRIPT", cartCountScriptTag())
    .replace("RAW_ANNOUNCEMENT_SCRIPT", (opts.announcement && opts.announcement.dismissible) ? announcementScriptTag() : "")
    .replace("RAW_CURRENCY_SWITCHER", currencySwitcher({
      currencies:  opts.currency_options,
      selected:    opts.currency_selected,
      note:        opts.currency_note,
      redirect_to: opts.currency_redirect_to,
    }))
    .replace("RAW_BODY_PLACEHOLDER", opts.body);
}

export function renderHome(opts) {
  if (!opts || !Array.isArray(opts.products)) throw new TypeError("renderHome: opts.products required");
  var shopName    = opts.shopName || "blamejs.shop";
  var cartCount   = opts.cartCount == null ? 0 : opts.cartCount;
  var title       = "Shop";
  var version     = opts.version;
  var assetPrefix = opts.assetPrefix || "/assets/";
  var searchQ     = opts.searchQ == null ? "" : opts.searchQ;
  var themeCss    = opts.themeCss;
  // Display-currency formatter — converts base → display when a currency
  // context is active, otherwise base-currency `formatPrice`.
  var fmt = makeFormatPrice(opts.currencyContext);

  var products = opts.products.map(function (p) {
    var priceStr = p.starting_price_minor != null
      ? fmt(p.starting_price_minor, p.starting_price_currency || "USD")
      : "—";
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

  var cards = products.map(function (p) { return _buildProductCard(p); }).join("\n");
  var catalog = products.length === 0
    ? CATALOG_EMPTY
    : renderTemplate(CATALOG_HEAD, { cards: "RAW_CARDS_PLACEHOLDER" }).replace("RAW_CARDS_PLACEHOLDER", cards);

  var heroProductCount = products.length === 0 ? "—" : String(products.length);

  var featuredProduct = null;
  for (var fi = 0; fi < products.length; fi += 1) {
    if (products[fi].image_url) { featuredProduct = products[fi]; break; }
  }
  var featuredHtml = "";
  if (featuredProduct) {
    var fpDesc = featuredProduct.description || "Server-rendered, PQC-secured, shipped from origin. Composed on the vendored blamejs framework.";
    featuredHtml =
      "<section class=\"featured-product\" aria-labelledby=\"featured-title\">\n" +
      "  <div class=\"featured-product__inner\">\n" +
      "    <a class=\"featured-product__media\" href=\"/products/" + escapeHtml(featuredProduct.slug) + "\">\n" +
      "      <img src=\"" + escapeHtml(featuredProduct.image_url) + "\" alt=\"" + escapeHtml(featuredProduct.image_alt || featuredProduct.title) + "\" loading=\"lazy\">\n" +
      "    </a>\n" +
      "    <div class=\"featured-product__copy\">\n" +
      "      <p class=\"eyebrow\">Featured</p>\n" +
      "      <h2 id=\"featured-title\" class=\"featured-product__title\">" + escapeHtml(featuredProduct.title) + "</h2>\n" +
      "      <p class=\"featured-product__lede\">" + escapeHtml(fpDesc) + "</p>\n" +
      "      <p class=\"featured-product__price\">" + escapeHtml(featuredProduct.price) + "</p>\n" +
      "      <a class=\"btn-primary\" href=\"/products/" + escapeHtml(featuredProduct.slug) + "\">View product <span aria-hidden=\"true\">→</span></a>\n" +
      "    </div>\n" +
      "  </div>\n" +
      "</section>";
  }

  var hero = renderTemplate(_buildHomeHero(version), { product_count: heroProductCount })
    .replace("RAW_FEATURED_CALLOUT", featuredHtml);

  // Schema.org Organization + WebSite JSON-LD. The Organization
  // block surfaces in Google's knowledge-panel results (logo +
  // social links); the WebSite block carries the sitelinks search
  // box that pin-points the storefront's `/search?q=` URL pattern.
  var jsonLd =
    jsonLdScript({
      "@context": "https://schema.org",
      "@type":    "Organization",
      "name":     shopName,
      "url":      "https://" + shopName.replace(/^https?:\/\//, ""),
      "logo":     "https://" + shopName.replace(/^https?:\/\//, "") + "/assets/brand/logo.png",
      "sameAs":   ["https://github.com/blamejs/blamejs.shop"],
    }) +
    jsonLdScript({
      "@context": "https://schema.org",
      "@type":    "WebSite",
      "name":     shopName,
      "url":      "https://" + shopName.replace(/^https?:\/\//, ""),
      "potentialAction": {
        "@type":       "SearchAction",
        "target":      "https://" + shopName.replace(/^https?:\/\//, "") + "/search?q={search_term_string}",
        "query-input": "required name=search_term_string",
      },
    });
  var body = hero + catalog + jsonLd;

  return _wrap({
    title:          title,
    shop_name:      shopName,
    cart_count:     cartCount,
    search_q:       searchQ,
    theme_css:      themeCss,
    version:        version,
    og_description: "Shop the blamejs.shop catalog — an open-source, server-rendered storefront with post-quantum crypto and zero npm runtime dependencies.",
    canonical_url:  opts.canonicalUrl,
    og_url:         opts.ogUrl,
    locale:         opts.locale,
    default_locale: opts.defaultLocale,
    chrome_overrides: opts.chromeOverrides,
    currency_options:     opts.currencyOptions,
    currency_selected:    opts.currencySelected,
    currency_note:        opts.currencyNote,
    currency_redirect_to: opts.currencyRedirectTo,
    announcement:   opts.announcement,
    body:           body,
  });
}
