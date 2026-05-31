import { renderTemplate, escapeAttr, assetUrl, stylesheetIntegrityAttr, CONSENT_BANNER, consentScriptTag, cartCountScriptTag, announcementBar, announcementScriptTag, makeFormatPrice, currencySwitcher } from "./_lib.js";
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
  "RAW_ROBOTS_META" +
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

var CART_PAGE =
  "<section class=\"cart-page\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\">\n" +
  "    <ol>\n" +
  "      <li><a href=\"/\">Shop</a></li>\n" +
  "      <li aria-current=\"page\">Cart</li>\n" +
  "    </ol>\n" +
  "  </nav>\n" +
  "RAW_CART_NOTICE" +
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
  "      <a href=\"/\" class=\"btn-ghost cart-page__continue\">← Continue shopping</a>\n" +
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
  "      <p class=\"cart-empty__icon\" aria-hidden=\"true\"><svg class=\"empty-illu\" viewBox=\"0 0 200 132\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M52 50 H66 L74 90 H128 L138 58 H72\"/><path d=\"M46 44 H56\" stroke=\"#732A8D\"/><circle cx=\"82\" cy=\"106\" r=\"7\"/><circle cx=\"120\" cy=\"106\" r=\"7\"/><path d=\"M84 72 H122\" stroke=\"currentColor\" stroke-opacity=\"0.45\" stroke-width=\"1.8\" stroke-dasharray=\"2 4\"/><path d=\"M150 38 L150 50 M144 44 L156 44\" stroke=\"#732A8D\" stroke-width=\"2\"/></svg></p>\n" +
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

// Fill the chrome placeholders + lang/dir into the LAYOUT for the
// resolved locale (the edge serves the default locale; any explicit
// choice bypasses the edge to the container). Mirrors the container's
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
  var shopName = opts.shop_name || "blamejs.shop";
  var themeCss = (typeof opts.theme_css === "string" && opts.theme_css.length)
    ? opts.theme_css
    : assetUrl("css/main.css");
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
    .replace("RAW_ROBOTS_META", (opts.robots === "noindex")
      ? "  <meta name=\"robots\" content=\"noindex,nofollow\">\n"
      : "")
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

export function renderCart(opts) {
  if (!opts) throw new TypeError("renderCart: opts required");
  if (!opts.totals) throw new TypeError("renderCart: opts.totals required");
  var lines       = opts.lines || [];
  var totals      = opts.totals;
  var lookup      = opts.productLookup || {};
  var shopName    = opts.shopName || "blamejs.shop";
  var cartCount   = opts.cartCount == null ? 0 : opts.cartCount;
  var searchQ     = opts.searchQ == null ? "" : opts.searchQ;
  var assetPrefix = opts.assetPrefix || "/assets/";
  var version     = opts.version;
  var themeCss    = opts.themeCss;
  // Display-currency formatter — converts base → display when active.
  var fmt = makeFormatPrice(opts.currencyContext);

  var subtotal = fmt(totals.subtotal_minor, totals.currency);
  var total    = fmt(totals.grand_total_minor, totals.currency);

  var body;
  if (lines.length === 0) {
    body = CART_EMPTY_PAGE;
  } else {
    var rows = lines.map(function (l) {
      var match = Object.prototype.hasOwnProperty.call(lookup, l.variant_id) ? lookup[l.variant_id] : null;
      // drop-silent fallback: a line whose variant was deleted between cart
      // write and render still gets a row instead of crashing the page.
      var prod = match && match.product;
      var hero = match && match.hero_media;

      var productTitle;
      var productUrl;
      var thumb;
      if (match === null || match === undefined) {
        productTitle = "Unavailable item";
        productUrl   = "#";
        thumb = "<span class=\"cart-line__thumb cart-line__thumb--empty\" aria-hidden=\"true\"></span>";
      } else {
        productTitle = (prod && prod.title) || l.sku || l.variant_title || "Unavailable item";
        productUrl   = prod && prod.slug ? "/products/" + prod.slug : "#";
        if (hero && hero.r2_key) {
          var imageUrl = assetPrefix + hero.r2_key;
          var imageAlt = hero.alt_text || (prod && prod.title) || l.sku || "";
          thumb = "<span class=\"cart-line__thumb\"><img src=\"" + escapeAttr(imageUrl) + "\" alt=\"" + escapeAttr(imageAlt) + "\" loading=\"lazy\"></span>";
        } else {
          thumb = "<span class=\"cart-line__thumb cart-line__thumb--empty\" aria-hidden=\"true\"></span>";
        }
      }

      var sku = l.sku || l.variant_title || "";
      var currency = l.currency || totals.currency;
      var unit = fmt(l.unit_price_minor, currency);
      var lineTotal = fmt(l.line_total_minor, currency);

      return renderTemplate(CART_LINE_EDITABLE, {
        sku:           sku,
        qty:           String(l.qty),
        unit:          unit,
        total:         lineTotal,
        line_id:       String(l.id),
        product_title: productTitle,
        product_url:   productUrl,
      }).replace("RAW_CART_LINE_THUMB", thumb);
    }).join("");

    body = renderTemplate(CART_PAGE, {
      line_rows: "RAW_LINES",
      subtotal:  subtotal,
      total:     total,
    }).replace("RAW_LINES", rows).replace("RAW_CART_NOTICE", "");
  }

  return _wrap({
    title:      "Cart",
    shop_name:  shopName,
    cart_count: cartCount,
    search_q:   searchQ,
    theme_css:  themeCss,
    version:    version,
    og_title:   "Cart — " + shopName,
    // The cart is session-scoped + robots.txt-disallowed — stamp a noindex
    // meta so the head matches the container cart and a directly-crawled
    // cart URL is self-describing (paired with the x-robots-tag header the
    // edge cart route sets).
    robots:     "noindex",
    locale:         opts.locale,
    default_locale: opts.defaultLocale,
    chrome_overrides: opts.chromeOverrides,
    body:       body,
    announcement:         opts.announcement,
    currency_options:     opts.currencyOptions,
    currency_selected:    opts.currencySelected,
    currency_note:        opts.currencyNote,
    currency_redirect_to: opts.currencyRedirectTo,
  });
}
