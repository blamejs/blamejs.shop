import { renderTemplate, escapeHtml, escapeAttr, jsonLdScript, assetUrl, stylesheetIntegrityAttr, CONSENT_BANNER, consentScriptTag, cartCountScriptTag, announcementBar, announcementScriptTag, makeFormatPrice, currencySwitcher, spliceRaw, absoluteBase, absolutizeOgImage } from "./_lib.js";
import { resolveChrome, dirFor, localizeLayout, alternateLinks } from "./chrome-i18n.js";

var LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"{{lang}}\" dir=\"{{dir}}\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <title>{{title}} — {{shop_name}}</title>\n" +
  "  <meta name=\"description\" content=\"{{og_description}}\">\n" +
  "  <link rel=\"canonical\" href=\"{{canonical_url}}\">\n" +
  "RAW_HREFLANG" +
  "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"/assets/brand/favicon.svg\">\n" +
  "  <link rel=\"icon\" type=\"image/png\" href=\"/assets/brand/favicon.png\">\n" +
  "  <link rel=\"apple-touch-icon\" href=\"/assets/brand/favicon.png\">\n" +
  "  <link rel=\"manifest\" href=\"/manifest.webmanifest\">\n" +
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
  "        <div class=\"site-nav__links\">\n" +
  "          <a class=\"site-nav__link\" href=\"/\">{{nav_shop}}</a>\n" +
  "          <a class=\"site-nav__link\" href=\"/collections\">{{nav_collections}}</a>\n" +
  "          <a class=\"site-nav__link\" href=\"/categories\">{{nav_categories}}</a>\n" +
  "          <a class=\"site-nav__link\" href=\"/#framework\">{{nav_framework}}</a>\n" +
  "        </div>\n" +
  "        <details class=\"site-nav__menu\">\n" +
  "          <summary class=\"site-nav__menu-toggle\" aria-label=\"{{nav_menu}}\"><svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" aria-hidden=\"true\"><path d=\"M4 7h16M4 12h16M4 17h16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\"/></svg><span class=\"site-nav__menu-label\">{{nav_menu}}</span></summary>\n" +
  "          <div class=\"site-nav__drawer\">\n" +
  "            <a class=\"site-nav__link\" href=\"/\">{{nav_shop}}</a>\n" +
  "            <a class=\"site-nav__link\" href=\"/collections\">{{nav_collections}}</a>\n" +
  "            <a class=\"site-nav__link\" href=\"/categories\">{{nav_categories}}</a>\n" +
  "            <a class=\"site-nav__link\" href=\"/#framework\">{{nav_framework}}</a>\n" +
  "          </div>\n" +
  "        </details>\n" +
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

// PDP buy-box. A single cart-add form posting `variant_id` + `qty` to
// /cart/lines (unchanged endpoint + field names). Multi-variant
// selection is server-rendered radio chips sharing `name="variant_id"`
// — the checked radio is what POSTs, so variant choice works with zero
// client JS. The lead price renders large + mono + violet; each chip
// carries its own price so a shopper sees per-variant pricing before
// they pick. Above twelve variants the chip wall gets unwieldy, so the
// existing compact variant table (VARIANT_ROW) is the fallback — it
// keeps a per-row add form, so the same endpoint contract holds.
// `variants` is the pre-formatted array [{ id, sku, title, price }]
// the renderers already build; `escAttr` is the path's HTML escaper.
// `availability` is the resolved `{ in_stock }` shape — an out-of-stock
// product renders a disabled add control with an honest message instead
// of an active button. Mirrors the container
// (lib/storefront.js#_buildBuyBox) byte-for-byte.
var BUYBOX_CHIP_LIMIT = 12;

// Compute the PDP buy-box headline price string — edge mirror of
// lib/storefront.js#_buildHeadlinePrice. Multi-variant products with >1
// distinct price read "From <lowest>" (min over integer amount_minor,
// formatted once via `fmt`); single-variant / no-price / all-equal-price
// keep the lead variant's exact formatted price. Byte-identical to the
// container.
function _buildHeadlinePrice(rendered, variants, prices, fmt) {
  var leadPrice = (rendered[0] && rendered[0].price) || "—";
  if (!Array.isArray(rendered) || rendered.length <= 1) return leadPrice;
  var lowMinor = null;
  var lowCurrency = null;
  for (var i = 0; i < variants.length; i += 1) {
    var p = prices && prices[variants[i].id];
    if (!p || !Number.isInteger(p.amount_minor)) continue;
    if (lowMinor === null || p.amount_minor < lowMinor) {
      lowMinor = p.amount_minor;
      lowCurrency = p.currency || "USD";
    }
  }
  if (lowMinor === null) return leadPrice;
  var allEqual = true;
  for (var j = 0; j < variants.length; j += 1) {
    var pj = prices && prices[variants[j].id];
    if (pj && Number.isInteger(pj.amount_minor) && pj.amount_minor !== lowMinor) { allEqual = false; break; }
  }
  if (allEqual) return leadPrice;
  return "From " + fmt(lowMinor, lowCurrency);
}

function _buildBuyBox(variants, escAttr, availability, headlinePrice) {
  var inStock = !availability || availability.in_stock !== false;
  if (!variants || variants.length === 0) {
    return "<div class=\"pdp__variants\">\n" +
           "        <h2 class=\"pdp__variants-title\">Choose a variant</h2>\n" +
           "        <div class=\"table-scroll\">\n" +
           "          <table class=\"variant-table\">\n" +
           "            <thead><tr><th>Variant</th><th>SKU</th><th>Price</th><th class=\"variant-table__action-h\">Action</th></tr></thead>\n" +
           "            <tbody><tr><td colspan=\"4\" class=\"empty\">No variants available.</td></tr></tbody>\n" +
           "          </table>\n" +
           "        </div>\n" +
           "      </div>";
  }

  var trustLine =
    "<div class=\"pdp__meta\">\n" +
    "        <span class=\"pdp__badge\"><img class=\"pdp__badge-mark\" src=\"/assets/brand/favicon.svg\" alt=\"\" aria-hidden=\"true\" width=\"22\" height=\"22\"> Post-quantum secured checkout · ML-KEM-1024 key agreement · ML-DSA-65 receipt signature.</span>\n" +
    "      </div>";

  var soldOutBtn =
    "<button type=\"submit\" class=\"btn-primary cart-page__checkout\" disabled aria-disabled=\"true\">Out of stock</button>\n" +
    "          <p class=\"pdp__soldout-note\" role=\"status\">This item is currently out of stock.</p>";
  var soldOutRowBtn =
    "<button type=\"submit\" class=\"btn-primary btn-primary--sm\" disabled aria-disabled=\"true\">Out of stock</button>";

  // "Notify me when back in stock" — a cookie-less, edge-cache-safe form
  // posting to the DISTINCT CSRF-exempt action `/stock-alert/subscribe`
  // (NOT /products/:slug/notify — that would over-exempt the token-required
  // review + question POSTs). The action is in EDGE_POST_PATHS, so the
  // container's `_injectCsrfFields` leaves it un-tokened, keeping this markup
  // byte-identical to the worker twin. sku/variant are catalog data; escape
  // anyway (escape-by-default). DUAL-RENDER: this helper is byte-identical to
  // worker/render/product.js#_buildBuyBox._notifyForm.
  function _notifyForm(sku, variantId) {
    return "<form class=\"pdp__notify\" method=\"post\" action=\"/stock-alert/subscribe\">\n" +
           "          <input type=\"hidden\" name=\"sku\" value=\"" + escAttr(sku) + "\">\n" +
           (variantId ? "          <input type=\"hidden\" name=\"variant_id\" value=\"" + escAttr(variantId) + "\">\n" : "") +
           "          <label class=\"pdp__notify-label\" for=\"notify-email-" + escAttr(sku) + "\">Email me when this is back in stock</label>\n" +
           "          <input id=\"notify-email-" + escAttr(sku) + "\" type=\"email\" name=\"email\" required placeholder=\"you@example.com\" autocomplete=\"email\">\n" +
           "          <button type=\"submit\" class=\"btn-secondary btn-primary--sm\">Notify me</button>\n" +
           "        </form>";
  }

  // Many variants → keep the compact table (still a per-row add form).
  if (variants.length > BUYBOX_CHIP_LIMIT) {
    var rows = variants.map(function (v) {
      var row = renderTemplate(VARIANT_ROW, { title: v.title, sku: v.sku, price: v.price, variant_id: v.id });
      // When the product is out of stock, swap each per-row add button for
      // the disabled control + a per-row notify form so no row offers an
      // active purchase but every sold-out SKU offers the alert.
      if (!inStock) {
        row = row.replace(
          "<button type=\"submit\" class=\"btn-primary btn-primary--sm\">Add to cart</button>",
          soldOutRowBtn + _notifyForm(v.sku, v.id));
      }
      return row;
    }).join("");
    return "<div class=\"pdp__variants\">\n" +
           "        <h2 class=\"pdp__variants-title\">Choose a variant</h2>\n" +
           "        <div class=\"table-scroll\">\n" +
           "          <table class=\"variant-table\">\n" +
           "            <thead><tr><th>Variant</th><th>SKU</th><th>Price</th><th class=\"variant-table__action-h\">Action</th></tr></thead>\n" +
           "            <tbody>" + rows + "</tbody>\n" +
           "          </table>\n" +
           "        </div>\n" +
           "      </div>\n" +
           "      " + trustLine;
  }

  var lead = variants[0];
  var single = variants.length === 1;
  var chips = "";
  if (!single) {
    for (var i = 0; i < variants.length; i += 1) {
      var v = variants[i];
      chips +=
        "<label class=\"pdp__badge\">" +
          "<input type=\"radio\" name=\"variant_id\" value=\"" + escAttr(v.id) + "\"" + (i === 0 ? " checked" : "") + ">" +
          " <span class=\"variant-row__title\">" + escAttr(v.title) + "</span>" +
          " <span class=\"variant-row__sku\"><code>" + escAttr(v.sku) + "</code></span>" +
          " <span class=\"variant-row__price price\">" + escAttr(v.price) + "</span>" +
        "</label>";
    }
  }

  var variantBlock = single
    ? "<p class=\"variant-row__sku\"><code>" + escAttr(lead.sku) + "</code></p>" +
      "<input type=\"hidden\" name=\"variant_id\" value=\"" + escAttr(lead.id) + "\">"
    : "<fieldset class=\"pdp__variants\">\n" +
      "          <legend class=\"pdp__variants-title\">Choose a variant</legend>\n" +
      "          <div class=\"pdp__meta\">" + chips + "</div>\n" +
      "        </fieldset>";

  var addControl = inStock
    ? "<button type=\"submit\" class=\"btn-primary cart-page__checkout\">$ add to cart</button>"
    : soldOutBtn;

  // Out-of-stock chip/single buy box → the notify form sits OUTSIDE the
  // add-to-cart form (its own form element, distinct action), after the
  // sold-out control. Keyed to the LEAD variant's SKU — the chip radio does
  // not JS-swap the hidden field (Trusted Types / no innerHTML island), so a
  // shopper subscribes against the lead SKU. Documented limitation.
  var notifyBlock = inStock ? "" : ("\n        " + _notifyForm(lead.sku, lead.id));

  var headline = (headlinePrice != null && headlinePrice !== "") ? headlinePrice : lead.price;
  return "<div class=\"pdp__buybox\">\n" +
         "        <p class=\"featured-product__price\">" + escAttr(headline) + "</p>\n" +
         "        <form method=\"post\" action=\"/cart/lines\">\n" +
         "          " + variantBlock + "\n" +
         "          <label class=\"pdp__variants-title\" for=\"buybox-qty\">Quantity</label>\n" +
         "          <input id=\"buybox-qty\" type=\"number\" name=\"qty\" value=\"1\" min=\"1\" max=\"99\" class=\"variant-row__qty\" aria-label=\"Quantity\">\n" +
         "          " + addControl + "\n" +
         "        </form>" + notifyBlock + "\n" +
         "      </div>\n" +
         "      " + trustLine;
}

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
  "      RAW_AVAILABILITY_PLACEHOLDER\n" +
  "      RAW_BUYBOX_PLACEHOLDER\n" +
  "      RAW_SHIPPING_NOTE_PLACEHOLDER\n" +
  "      RAW_QTYBREAK_PLACEHOLDER\n" +
  "      RAW_WISHLIST_PLACEHOLDER\n" +
  "      RAW_COMPARE_PLACEHOLDER\n" +
  "    </div>\n" +
  "  </div>\n" +
  "  RAW_BUNDLES_PLACEHOLDER\n" +
  "  RAW_REVIEWS_PLACEHOLDER\n" +
  "  RAW_QA_PLACEHOLDER\n" +
  "</section>\n" +
  "RAW_RELATED_PLACEHOLDER";

// Product-card markup + builder — byte-identical to the container
// (lib/storefront.js#PRODUCT_CARD_IMAGE / #PRODUCT_CARD / #_buildProductCard)
// and the edge home/search card builders, so the "You may also like"
// rail renders the same tiles wherever the PDP is served.
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

// PDP "You may also like" rail. `related` is the pre-decorated card
// list [{ slug, title, price, image_url, image_alt }] the renderer
// builds from the same-collection picks. Reuses the catalog grid +
// product-card markup so it inherits the storefront's card styling.
// Returns "" when there's nothing to show so the PDP renders no empty
// rail. Mirrors the container (lib/storefront.js#_buildRelatedProducts)
// byte-for-byte.
function _buildRelatedProducts(related) {
  related = related || [];
  if (related.length === 0) return "";
  var cards = related.map(function (p) { return _buildProductCard(p); }).join("");
  return "<section class=\"catalog-section pdp-recommendations\" aria-labelledby=\"pdp-related-title\">" +
           "<header class=\"section-head\"><h2 id=\"pdp-related-title\" class=\"section-head__title\">You may also like</h2></header>" +
           "<div class=\"grid\">" + cards + "</div>" +
         "</section>";
}

// Product-level "Save to wishlist" control + social-proof count. The
// toggle is a plain form POST to the container route (the edge can't
// read the sealed session to know if THIS customer already saved it,
// so the label is action-only; the account page is the source of truth
// for saved items). The count is public and rendered at the edge.
// Shared verbatim by the container renderer.
function _buildWishlist(productId, count) {
  var n = Number(count) || 0;
  var countHtml = n > 0
    ? "<span class=\"wishlist__count\">" + n + (n === 1 ? " shopper saved this" : " shoppers saved this") + "</span>"
    : "";
  return "<div class=\"wishlist\">" +
           "<form class=\"wishlist__form\" method=\"post\" action=\"/wishlist/toggle\">" +
             "<input type=\"hidden\" name=\"product_id\" value=\"" + escapeAttr(productId) + "\">" +
             "<button type=\"submit\" class=\"btn-secondary wishlist__btn\">" +
               "<span class=\"wishlist__heart\" aria-hidden=\"true\">♡</span> Save to wishlist" +
             "</button>" +
           "</form>" +
           countHtml +
         "</div>";
}

// Product-level "Add to compare" control. The toggle is a plain form
// POST to the container route (the edge can't read the sealed session
// to know if THIS product is already in the basket, so the label is
// action-only; the /compare table is the source of truth for the
// current basket). Shared verbatim with the container renderer so both
// substrates emit identical markup.
function _buildCompare(productId) {
  return "<div class=\"compare\">" +
           "<form class=\"compare__form\" method=\"post\" action=\"/compare/toggle\">" +
             "<input type=\"hidden\" name=\"product_id\" value=\"" + escapeAttr(productId) + "\">" +
             "<button type=\"submit\" class=\"btn-secondary compare__btn\">" +
               "<span class=\"compare__icon\" aria-hidden=\"true\">⇄</span> Add to compare" +
             "</button>" +
           "</form>" +
           "<a class=\"compare__link card-link\" href=\"/compare\">View compare →</a>" +
         "</div>";
}

// Accessible star glyph row. `value` is the displayed rating (rounded
// to the nearest whole star for the glyph fill); the precise figure
// rides in the visually-hidden label so a screen reader announces
// "4.3 out of 5 stars" while sighted users see four-and-a-bit filled
// stars. `aria-hidden` on the glyphs prevents double-announcement.
function _stars(value, label) {
  var filled = Math.round(value);
  if (filled < 0) filled = 0;
  if (filled > 5) filled = 5;
  var glyphs = "";
  for (var i = 1; i <= 5; i += 1) {
    glyphs += "<span class=\"star" + (i <= filled ? " star--on" : "") + "\">" +
      (i <= filled ? "★" : "☆") + "</span>";
  }
  return "<span class=\"stars\" aria-hidden=\"true\">" + glyphs + "</span>" +
         "<span class=\"sr-only\">" + escapeHtml(label) + "</span>";
}

function _reviewDate(ts) {
  var n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  // Locale-neutral ISO date (UTC) — deterministic across the edge's
  // many PoPs, no Intl timezone surprises in the cached HTML.
  return new Date(n).toISOString().slice(0, 10);
}

// Builds the PDP reviews block from the published aggregate + list
// fetched at the edge (`worker/data/catalog.js#getReviewSummary` /
// `#listPublishedReviews`). Renders the "no reviews yet" empty state
// when the product has none — the section header always shows so the
// submission form (server-rendered into RAW_FORM) has a home.
function _buildReviews(summary, reviews, formHtml) {
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
          "<span class=\"reviews__average-num\">" + escapeHtml(avgStr) + "</span>" +
          _stars(avg, avgStr + " out of 5 stars") +
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
      ? "<p class=\"review__body\">" + escapeHtml(String(r.body)) + "</p>"
      : "";
    list +=
      "<li class=\"review\">" +
        "<div class=\"review__head\">" +
          _stars(rating, rating + " out of 5 stars") +
          "<h3 class=\"review__title\">" + escapeHtml(String(r.title || "")) + "</h3>" +
        "</div>" +
        "<div class=\"review__meta\">" + verified +
          (date ? "<time class=\"review__date\" datetime=\"" + escapeAttr(date) + "\">" + escapeHtml(date) + "</time>" : "") +
        "</div>" +
        bodyHtml +
      "</li>";
  }
  var listHtml = list
    ? "<ul class=\"reviews__list\">" + list + "</ul>"
    : "";

  return "<section class=\"reviews\" aria-labelledby=\"reviews-title\">" +
           "<h2 id=\"reviews-title\" class=\"reviews__heading\">Customer reviews</h2>" +
           head +
           listHtml +
           (formHtml || "") +
         "</section>";
}
// Builds the PDP Product Q&A block from the approved questions + their
// approved answers fetched at the edge
// (`worker/data/catalog.js#listProductQaThreads`). Renders the "no
// questions yet" empty state when the product has none. Reuses the
// reviews section's theme classes so no new CSS ships. Mirrors the
// container renderer (`lib/storefront.js#_buildProductQa`) byte-for-byte
// so both render paths stay in sync.
function _buildProductQa(questions, ctaHtml) {
  questions = questions || [];

  var head;
  if (questions.length > 0) {
    head = "<p class=\"reviews__count\">" + questions.length +
      (questions.length === 1 ? " question answered" : " questions answered") + "</p>";
  } else {
    head = "<p class=\"reviews__empty\">No questions yet. Be the first to ask about this product.</p>";
  }

  var list = "";
  for (var i = 0; i < questions.length; i += 1) {
    var q = questions[i];
    var answers = q.answers || [];
    var answerHtml = "";
    for (var j = 0; j < answers.length; j += 1) {
      var a = answers[j];
      var who = Number(a.is_operator) === 1
        ? "<span class=\"review__verified\">Answered by the seller</span>"
        : (a.author === "system"
            ? "<span class=\"review__verified\">Automated answer</span>"
            : "<span class=\"review__verified\">Customer answer</span>");
      var pinned = Number(a.pinned) === 1
        ? "<span class=\"review__verified\">Top answer</span>"
        : "";
      answerHtml +=
        "<li class=\"review qa__answer\">" +
          "<div class=\"review__meta\">" + who + pinned + "</div>" +
          "<p class=\"review__body\">" + escapeHtml(String(a.body)) + "</p>" +
        "</li>";
    }
    var answerList = answerHtml
      ? "<ul class=\"reviews__list qa__answers\">" + answerHtml + "</ul>"
      : "<p class=\"reviews__empty\">Awaiting an answer.</p>";
    list +=
      "<li class=\"review qa__question\">" +
        "<div class=\"review__head\">" +
          "<h3 class=\"review__title\">" + escapeHtml(String(q.body)) + "</h3>" +
        "</div>" +
        answerList +
      "</li>";
  }
  var listHtml = list ? "<ul class=\"reviews__list\">" + list + "</ul>" : "";

  return "<section class=\"reviews qa\" aria-labelledby=\"qa-title\">" +
           "<h2 id=\"qa-title\" class=\"reviews__heading\">Questions &amp; answers</h2>" +
           head +
           listHtml +
           (ctaHtml || "") +
         "</section>";
}

// QAPage JSON-LD from the PDP's published Q&A threads — the byte-identical
// twin of the container's `lib/storefront.js#_buildQaPageJsonLd` (a parity
// test pins the two). Emitted only when at least one question has at least
// one answer (Google rejects a QAPage Question with neither an
// `acceptedAnswer` nor a `suggestedAnswer`). The first answer is the
// `acceptedAnswer`; the rest are `suggestedAnswer`. `q.body` / `a.body` are
// operator/customer free text — `jsonLdScript` JSON.stringify's them
// (neutralizing quotes + the `</script` breakout), so they are NOT
// additionally HTML-escaped (JSON-LD is not HTML, per the jsonLdScript
// contract). Returns "" when nothing is rich-result-eligible.
function _buildQaPageJsonLd(questions) {
  questions = questions || [];
  var mainEntity = [];
  for (var i = 0; i < questions.length; i += 1) {
    var q = questions[i];
    var answers = (q && q.answers) || [];
    if (answers.length === 0) continue;
    var question = {
      "@type":       "Question",
      "name":        String(q.body),
      "answerCount": answers.length,
      "acceptedAnswer": { "@type": "Answer", "text": String(answers[0].body) },
    };
    if (answers.length > 1) {
      var suggested = [];
      for (var j = 1; j < answers.length; j += 1) {
        suggested.push({ "@type": "Answer", "text": String(answers[j].body) });
      }
      question.suggestedAnswer = suggested;
    }
    mainEntity.push(question);
  }
  if (mainEntity.length === 0) return "";
  return jsonLdScript({
    "@context":   "https://schema.org",
    "@type":      "QAPage",
    "mainEntity": mainEntity,
  });
}

// Builds the PDP "Bundle & save" rail. `offers` carry pre-formatted
// price strings (the edge renderer formats the minor-unit figures from
// `worker/data/catalog.js#getBundlesForProduct` before calling this) so
// this is pure string assembly. Mirrors the container renderer
// (`lib/storefront.js#_renderBundles`) byte-for-byte so both render
// paths emit identical markup. An unavailable offer renders disabled
// with a reason instead of the add form. Returns "" when there are no
// offers so the PDP shows no empty rail.
function _buildBundles(offers) {
  offers = offers || [];
  if (offers.length === 0) return "";
  var cards = "";
  for (var i = 0; i < offers.length; i += 1) {
    var o = offers[i];
    var members = "";
    for (var j = 0; j < o.components.length; j += 1) {
      var c = o.components[j];
      members +=
        "<li class=\"bundle-card__member\">" +
          "<span class=\"bundle-card__member-qty\">" + escapeHtml(String(c.quantity)) + "&times;</span> " +
          "<span class=\"bundle-card__member-title\">" + escapeHtml(String(c.title)) + "</span> " +
          "<code class=\"bundle-card__member-sku\">" + escapeHtml(String(c.sku)) + "</code>" +
        "</li>";
    }
    var pricing =
      "<div class=\"bundle-card__pricing\">" +
        "<span class=\"bundle-card__list\">Buy separately " + escapeHtml(o.list_total_str) + "</span>" +
        "<span class=\"bundle-card__price price\">Bundle price " + escapeHtml(o.amount_str) + "</span>" +
        (o.discount_str ? "<span class=\"bundle-card__save\">You save " + escapeHtml(o.discount_str) + "</span>" : "") +
      "</div>";
    var action;
    if (o.available) {
      action =
        "<form method=\"post\" action=\"/cart/bundle\" class=\"bundle-card__form\">" +
          "<input type=\"hidden\" name=\"bundle_sku\" value=\"" + escapeHtml(o.bundle_sku) + "\">" +
          "<button type=\"submit\" class=\"btn-primary btn-primary--sm\">Add bundle to cart</button>" +
        "</form>";
    } else {
      action =
        "<p class=\"bundle-card__unavailable\">" +
          escapeHtml(o.unavailable_reason || "This bundle is currently unavailable.") +
        "</p>";
    }
    cards +=
      "<article class=\"bundle-card" + (o.available ? "" : " bundle-card--unavailable") + "\">" +
        "<h3 class=\"bundle-card__title\">" + escapeHtml(String(o.title)) + "</h3>" +
        "<ul class=\"bundle-card__members\">" + members + "</ul>" +
        pricing +
        action +
      "</article>";
  }
  return "<section class=\"bundles\" aria-labelledby=\"bundles-title\">" +
           "<h2 id=\"bundles-title\" class=\"bundles__heading\">Bundle &amp; save</h2>" +
           "<div class=\"bundles__grid\">" + cards + "</div>" +
         "</section>";
}

// Builds the PDP quantity-break table. `breaks` carry pre-formatted
// unit-price strings (the edge renderer formats the minor-unit figures
// from `worker/data/catalog.js#getQtyBreaksForSku` first). Mirrors the
// container renderer (`lib/storefront.js#_renderQtyBreaks`) byte-for-
// byte. Returns "" when there are no breaks.
function _buildQtyBreaks(breaks) {
  breaks = breaks || [];
  if (breaks.length === 0) return "";
  var rows = "";
  for (var i = 0; i < breaks.length; i += 1) {
    var br = breaks[i];
    rows +=
      "<tr>" +
        "<td class=\"qty-break__range\">" + escapeHtml(String(br.label)) + "</td>" +
        "<td class=\"qty-break__unit price\">" + escapeHtml(String(br.unit_str)) + "</td>" +
      "</tr>";
  }
  return "<div class=\"qty-breaks\">" +
           "<h2 class=\"qty-breaks__title\">Buy more, save more</h2>" +
           "<div class=\"table-scroll\">" +
             "<table class=\"qty-break-table\">" +
               "<thead><tr><th>Quantity</th><th>Price each</th></tr></thead>" +
               "<tbody>" + rows + "</tbody>" +
             "</table>" +
           "</div>" +
           "<p class=\"qty-breaks__note\">Discount applies automatically in your cart.</p>" +
         "</div>";
}


// Fill the chrome placeholders + lang/dir into the LAYOUT for the
// resolved locale (the edge serves the default locale; any explicit
// choice bypasses the edge to the container). Mirrors the container's
// `_wrap` chrome handling so a given locale yields identical markup.
function _localizeLayout(opts) {
  var defaultLocale = opts.defaultLocale || "en";
  var locale = opts.locale || defaultLocale;
  var chrome = resolveChrome(locale, { defaultLocale: defaultLocale, overrides: opts.chromeOverrides || {} });
  return localizeLayout(LAYOUT, {
    chrome:       chrome,
    lang:         locale,
    dir:          dirFor(locale),
    cartCount:    opts.cartCount == null ? 0 : opts.cartCount,
    switcherHtml: "",
  });
}

function _wrap(opts) {
  var shopName      = opts.shopName || "blamejs.shop";
  var ogType        = opts.ogType        || "website";
  var ogTitle       = opts.ogTitle       || (opts.title ? opts.title + " — " + shopName : shopName);
  var ogDescription = opts.ogDescription || "Open-source ecommerce framework built on blamejs. Server-rendered HTML, post-quantum crypto, zero npm runtime dependencies.";
  var canonicalUrl  = opts.canonicalUrl   || "";
  var ogUrl         = opts.ogUrl          || canonicalUrl;
  // og:image / twitter:image carry a FULLY-QUALIFIED URL — a relative hero
  // path (or the brand-logo default) is dropped by every social-share
  // crawler and by Google's product rich result. Absolutize against the
  // page origin; an operator-hosted `http(s)://` image passes through. The
  // value is already absolute when threaded from `renderProduct` (so the
  // JSON-LD `image` matches), and idempotent for any other caller.
  var ogImage       = absolutizeOgImage(opts.ogImage || "/assets/brand/logo.png", canonicalUrl, shopName);
  var localized = _localizeLayout(opts);
  var assembled = renderTemplate(localized, {
    title:          opts.title,
    shop_name:      shopName,
    cart_count:     opts.cartCount == null ? 0 : opts.cartCount,
    year:           String(new Date().getUTCFullYear()),
    search_q:       opts.searchQ == null ? "" : opts.searchQ,
    theme_css:      opts.themeCss,
    og_type:        ogType,
    og_title:       ogTitle,
    og_description: ogDescription,
    og_image:       ogImage,
    og_url:         ogUrl,
    canonical_url:  canonicalUrl,
    body:           "RAW_BODY_PLACEHOLDER",
  }).replace("RAW_CSS_INTEGRITY", stylesheetIntegrityAttr(opts.themeCss))
    .replace("RAW_HREFLANG", alternateLinks({
      host:             opts.host,
      path:             opts.path,
      defaultLocale:    opts.defaultLocale || "en",
      supportedLocales: opts.supportedLocales,
      strategy:         opts.localeStrategy,
    }))
    .replace("RAW_CONSENT_SCRIPT", consentScriptTag())
    .replace("RAW_CART_COUNT_SCRIPT", cartCountScriptTag())
    .replace("RAW_ANNOUNCEMENT_SCRIPT", (opts.announcement && opts.announcement.dismissible) ? announcementScriptTag() : "")
    .replace("RAW_CURRENCY_SWITCHER", currencySwitcher({
      currencies:  opts.currencyOptions,
      selected:    opts.currencySelected,
      note:        opts.currencyNote,
      redirect_to: opts.currencyRedirectTo,
    }));
  // The announcement bar carries operator-supplied message text (HTML-
  // escaped, but `$` is not an escaped character), so splice it via the
  // replacer-function helper — a `$&` / `` $` `` / `$N` in the message must
  // land literally, not trigger `String.replace`'s dollar substitution.
  // Same for the PDP body (a product description) below. See `spliceRaw`.
  assembled = spliceRaw(assembled, "RAW_ANNOUNCEMENT_BAR", announcementBar(opts.announcement || null));
  return spliceRaw(assembled, "RAW_BODY_PLACEHOLDER", opts.body);
}

// PDP gallery markup — a no-JS, CSS-`:checked` picker. Byte-identical to
// the container renderer (`lib/storefront.js#_buildPdpGallery`): every
// media row renders both as a hidden radio + a stacked main `<img>` (only
// the `:checked` radio's image shows) and as a `<label for>` thumbnail;
// activating a thumbnail checks its radio and CSS swaps the visible image.
// The first image is selected on load. A single-image product renders just
// that image with no thumbnail strip; absent media falls back to the
// letter-mark placeholder. Keep the two builders in sync on every change.
function _buildPdpGallery(product, media, assetPrefix) {
  var prefix = assetPrefix || "/assets/";
  if (!media || media.length === 0) {
    return "<figure class=\"pdp__media pdp__media--placeholder\" aria-hidden=\"true\">" +
             "<svg class=\"media-ph__svg\" viewBox=\"0 0 240 240\" aria-hidden=\"true\"><rect width=\"240\" height=\"240\" fill=\"none\"/><g stroke=\"currentColor\" stroke-opacity=\"0.10\" stroke-width=\"1\"><path d=\"M0 40 H240 M0 80 H240 M0 120 H240 M0 160 H240 M0 200 H240 M40 0 V240 M80 0 V240 M120 0 V240 M160 0 V240 M200 0 V240\"/></g><g fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M120 64 L162 80 L162 122 C162 152 144 168 120 178 C96 168 78 152 78 122 L78 80 Z\" stroke=\"#732A8D\" stroke-width=\"2.4\"/><path d=\"M120 92 L146 105 L146 134 L120 147 L94 134 L94 105 Z\"/><path d=\"M94 105 L120 118 L146 105 M120 118 V147\" stroke=\"#732A8D\" stroke-width=\"2.4\"/><path d=\"M107 101 L112 105 L107 109\" stroke=\"currentColor\" stroke-width=\"2.4\"/><path d=\"M116 110 H128\" stroke=\"currentColor\" stroke-width=\"2.4\"/></g><text x=\"120\" y=\"208\" text-anchor=\"middle\" font-family=\"ui-monospace,Menlo,Consolas,monospace\" font-size=\"12\" letter-spacing=\"2\" fill=\"#6b6b78\">no image yet</text></svg>" +
           "</figure>";
  }
  var hero = media[0];
  var heroAlt = hero.alt_text || product.title || "Product image";
  // The CSS picker (main.css) maps :checked radios through nth-of-type(12),
  // so render at most that many — a thumbnail that checked a radio with no
  // matching visibility rule would blank the gallery. Twelve covers any
  // realistic product; keep this in lockstep with the rule count in main.css.
  var shown = media.length < 12 ? media.length : 12;
  var radios = "";
  var imgs = "";
  var thumbs = "";
  for (var i = 0; i < shown; i += 1) {
    var m = media[i];
    var url = prefix + m.r2_key;
    var id = "pdp-img-" + i;
    var checked = i === 0 ? " checked" : "";
    var alt = i === 0 ? heroAlt : (m.alt_text || product.title || "Product image");
    var loading = i === 0 ? "eager" : "lazy";
    radios += "<input class=\"pdp__radio\" type=\"radio\" name=\"pdp-img\" id=\"" + escapeAttr(id) + "\"" + checked + ">";
    imgs += "<img class=\"pdp__img\" src=\"" + escapeAttr(url) + "\" alt=\"" + escapeAttr(alt) + "\" loading=\"" + loading + "\">";
    thumbs += "<li>" +
                "<label class=\"pdp__thumb\" for=\"" + escapeAttr(id) + "\">" +
                  "<img src=\"" + escapeAttr(url) + "\" alt=\"\">" +
                  "<span class=\"sr-only\">Show image " + (i + 1) + "</span>" +
                "</label>" +
              "</li>";
  }
  // Radios are siblings of the figure + thumbnail list (not nested), so a
  // checked radio can reach both the stacked images and the matching
  // thumbnail through the general-sibling combinator in CSS.
  var figure = "<figure class=\"pdp__media pdp__media--image pdp__media--gallery\">" + imgs + "</figure>";
  if (shown === 1) return radios + figure;
  return radios + figure + "<ul class=\"pdp__thumbs\">" + thumbs + "</ul>";
}

// Resolve a product's availability + shipping shape from the variant list
// + (optional) inventory map. Mirrors the container
// (`lib/storefront.js#_resolveAvailability`) so both render paths drive
// the badge + CTA + JSON-LD from the same shape. `in_stock` is true if ANY
// variant is buyable (a SKU with no inventory row counts as available —
// the never-block stance); `requires_shipping` is true if ANY variant
// ships physically; `low_stock` is the smallest still-buyable count across
// the tracked variants when that count is at or below the variant's
// operator-configured `low_stock_threshold` (null otherwise).
function _resolveAvailability(variants, inventoryBySku) {
  variants = Array.isArray(variants) ? variants : [];
  var inv = (inventoryBySku && typeof inventoryBySku === "object") ? inventoryBySku : null;
  var anyTracked = false;
  var anyInStock = false;
  var requiresShipping = false;
  var lowStock = null;
  for (var i = 0; i < variants.length; i += 1) {
    var v = variants[i] || {};
    if (v.requires_shipping === undefined || v.requires_shipping === null ||
        Number(v.requires_shipping) !== 0) {
      requiresShipping = true;
    }
    if (inv && Object.prototype.hasOwnProperty.call(inv, v.sku)) {
      anyTracked = true;
      var row = inv[v.sku];
      var available = row ? (Number(row.stock_on_hand) - Number(row.stock_held)) : 0;
      if (available > 0) anyInStock = true;
      var threshold = row ? Number(row.low_stock_threshold) : NaN;
      if (available > 0 && Number.isFinite(threshold) && available <= threshold) {
        if (lowStock === null || available < lowStock) lowStock = available;
      }
    }
  }
  return {
    in_stock:          anyTracked ? anyInStock : true,
    requires_shipping: variants.length === 0 ? true : requiresShipping,
    low_stock:         (anyTracked ? anyInStock : true) ? lowStock : null,
  };
}

// PDP availability badges. Mirrors the container
// (`lib/storefront.js#_buildAvailability`) byte-for-byte.
function _buildAvailability(availability) {
  var a = availability || { in_stock: true, requires_shipping: true };
  var low = Number(a.low_stock);
  var stockBadge;
  if (!a.in_stock) {
    stockBadge = "<span class=\"pdp__badge pdp__badge--out\">Out of stock</span>";
  } else if (Number.isFinite(low) && low > 0) {
    stockBadge = "<span class=\"pdp__badge pdp__badge--low\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> Only " + low + " left</span>";
  } else {
    stockBadge = "<span class=\"pdp__badge pdp__badge--ok\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> In stock</span>";
  }
  var shipBadge = a.requires_shipping
    ? "<span class=\"pdp__badge\">Ships in 1–2 business days</span>"
    : "<span class=\"pdp__badge\">Digital — delivered on purchase</span>";
  return "<div class=\"pdp__meta\">\n" +
         "        " + stockBadge + "\n" +
         "        " + shipBadge + "\n" +
         "        <span class=\"pdp__badge\">Stripe-secured checkout</span>\n" +
         "      </div>";
}

// Short shipping/returns line under the buy box. Mirrors the container
// (`lib/storefront.js#_pdpShippingNote`) byte-for-byte.
function _pdpShippingNote(availability) {
  var a = availability || { in_stock: true, requires_shipping: true };
  var copy = a.requires_shipping
    ? "Free returns within 30 days. "
    : "";
  return "<p class=\"pdp__shipping-note\">" + copy +
         "See our <a href=\"/terms\">shipping &amp; returns policy</a>.</p>";
}

// Pre-order CTA — replaces the add-to-cart buy box on a PDP whose lead SKU has
// an OPEN pre-order campaign. Mirrors the container
// (`lib/storefront.js#_buildPreorderCta`). `preorder` is the resolved shape:
// { product_slug, release_date_iso, remaining_units (null = unlimited),
// max_units_available, full_price_str, deposit_str (null when no deposit),
// sold_out, reserve_form }. The reserve POST is CSRF-protected + auth-gated,
// so the POST FORM is rendered ONLY by the container (`reserve_form: true`,
// where the `_csrf` token is injected); the edge sets `reserve_form: false`
// and renders a sign-in affordance instead of a token-less form. A signed-in
// customer's session-cookie request skips the edge cache and reaches the
// container form, so they always get the real (tokened) form; an anonymous
// edge visitor can't reserve anyway. Both substrates resolve the campaign from
// D1 at render time; the container read is always live, the edge copy can lag
// by up to the PDP cache TTL until the purge hook clears it.
function _buildPreorderCta(preorder, escAttr) {
  var soldOut = !!preorder.sold_out;
  var remaining = preorder.remaining_units;
  var availLine = remaining == null
    ? "<p class=\"pdp__preorder-avail\" role=\"status\">Open for pre-order.</p>"
    : (remaining > 0
        ? "<p class=\"pdp__preorder-avail\" role=\"status\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> " + escAttr(String(remaining)) + " of " + escAttr(String(preorder.max_units_available)) + " reservations remaining.</p>"
        : "<p class=\"pdp__preorder-avail\" role=\"status\">All reservations are spoken for.</p>");
  var depositLine = preorder.deposit_str
    ? "<p class=\"pdp__preorder-deposit\">Reserve with a " + escAttr(preorder.deposit_str) + " deposit · " + escAttr(preorder.full_price_str) + " total at launch.</p>"
    : "<p class=\"pdp__preorder-deposit\">No payment due now · " + escAttr(preorder.full_price_str) + " charged when it ships.</p>";
  var head =
    "<div class=\"pdp__buybox pdp__buybox--preorder\">\n" +
    "        <p class=\"pdp__badge pdp__badge--preorder\">Pre-order · ships " + escAttr(preorder.release_date_iso) + "</p>\n" +
    "        <p class=\"featured-product__price\">" + escAttr(preorder.full_price_str) + "</p>\n" +
    "        " + availLine + "\n" +
    "        " + depositLine + "\n";
  if (soldOut) {
    return head +
           "        <button type=\"submit\" class=\"btn-primary cart-page__checkout\" disabled aria-disabled=\"true\">Pre-orders full</button>\n" +
           "        <p class=\"pdp__soldout-note\" role=\"status\">Every pre-order reservation has been claimed.</p>\n" +
           "      </div>";
  }
  // The edge never carries a per-session CSRF token, so it renders a sign-in
  // affordance — NEVER the reserve POST form. The container twin
  // (lib/storefront.js#_buildPreorderCta) renders the real, token-injected
  // form for a signed-in customer (whose session-cookie request skips the
  // edge cache and reaches the container). `preorder.reserve_form` is always
  // false here; the form branch lives only in the container builder so this
  // file ships no token-less edge POST form.
  return head +
         "        <a class=\"btn-primary cart-page__checkout\" href=\"/account/login\">Sign in to reserve</a>\n" +
         "        <p class=\"pdp__preorder-note\">A reservation holds your unit. We charge through secure checkout when it launches.</p>\n" +
         "      </div>";
}

// Build the renderProduct `preorder` opts shape from a campaign row + the
// per-campaign reserved/cap counts + a price formatter. Returns null unless
// the campaign is OPEN (status 'active'). Mirrors the container
// (`lib/storefront.js#preorderCtaShape`). `remainingUnits` is `max - reserved`
// (or null for an unlimited campaign); `fmt(minor, currency)` is the page
// formatter; `slug` is the product slug. `reserve_form` is FALSE at the edge —
// the edge render carries no per-session CSRF token, so it shows a sign-in
// affordance instead of a token-less POST form (the container sets it true).
export function preorderCtaShape(campaign, remainingUnits, fmt, slug) {
  if (!campaign || campaign.status !== "active") return null;
  var max = campaign.max_units_available == null ? null : campaign.max_units_available;
  var deposit = Number(campaign.deposit_minor) || 0;
  return {
    product_slug:        slug,
    release_date_iso:    new Date(Number(campaign.launch_at)).toISOString().slice(0, 10),
    remaining_units:     remainingUnits,
    max_units_available: max,
    full_price_str:      fmt(campaign.full_price_minor, campaign.currency),
    deposit_str:         deposit > 0 ? fmt(deposit, campaign.currency) : null,
    sold_out:            remainingUnits != null && remainingUnits <= 0,
    reserve_form:        false,
  };
}

// The reserve-PRG banner, keyed off the closed ?preorder marker set so a
// forged query can never inject copy. Mirrors the container
// (`lib/storefront.js#_buildPreorderNotice`) byte-for-byte.
var _PREORDER_NOTICES = {
  reserved:    { kind: "ok",    copy: "Reserved. We'll email you when it ships and charge your card through secure checkout." },
  unavailable: { kind: "error", copy: "This pre-order couldn't be reserved — it may be full or closed. Nothing was charged." },
  closed:      { kind: "error", copy: "This pre-order is no longer open." },
};
function _buildPreorderNotice(marker) {
  var n = marker && Object.prototype.hasOwnProperty.call(_PREORDER_NOTICES, marker)
    ? _PREORDER_NOTICES[marker] : null;
  if (!n) return "";
  var cls = n.kind === "error" ? "form-notice form-notice--error" : "form-notice form-notice--ok";
  var role = n.kind === "error" ? "alert" : "status";
  return "<p class=\"" + cls + "\" role=\"" + role + "\">" + escapeHtml(n.copy) + "</p>\n      ";
}

export function renderProduct(opts) {
  if (!opts || !opts.product) throw new TypeError("renderProduct: opts.product required");
  if (!opts.variants) throw new TypeError("renderProduct: opts.variants required");
  if (!opts.prices) throw new TypeError("renderProduct: opts.prices required");
  var product     = opts.product;
  var variants    = opts.variants;
  var prices      = opts.prices;
  var media       = opts.media || [];
  var reviewSummary = opts.reviewSummary || { count: 0, avg_rating: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
  var reviews       = opts.reviews || [];
  var reviewForm    = typeof opts.reviewForm === "string" ? opts.reviewForm : "";
  var qaQuestions   = opts.qaQuestions || [];
  var qaForm        = typeof opts.qaForm === "string" ? opts.qaForm : "";
  // Bundle offers + quantity-break rows arrive in minor units from the
  // edge data layer; format them into the same display-string shape the
  // container builds before handing to the shared markup assemblers, so
  // the two render paths emit byte-identical HTML.
  // Display-currency formatter — converts base → display when a currency
  // context is active, otherwise base-currency `formatPrice`. The JSON-LD
  // block below intentionally stays in the base currency (it's the
  // machine-readable offer tied to the charge), so it bypasses `fmt`.
  var fmt = makeFormatPrice(opts.currencyContext);
  var bundleOffers  = (opts.bundleOffers || []).map(function (o) {
    return {
      bundle_sku:         o.bundle_sku,
      title:              o.title,
      components:         o.components,
      list_total_str:     fmt(o.list_total_minor, o.currency),
      amount_str:         fmt(o.amount_minor, o.currency),
      discount_str:       o.discount_minor > 0 ? fmt(o.discount_minor, o.currency) : null,
      available:          o.available,
      unavailable_reason: o.unavailable_reason,
    };
  });
  var qtyBreaks     = (opts.qtyBreaks || []).map(function (br) {
    return { label: br.label, unit_str: fmt(br.unit_minor, br.currency) };
  });
  var wishlistCount = opts.wishlistCount == null ? 0 : opts.wishlistCount;
  var shopName    = opts.shopName || "blamejs.shop";
  var cartCount   = opts.cartCount == null ? 0 : opts.cartCount;
  var searchQ     = opts.searchQ == null ? "" : opts.searchQ;
  var assetPrefix = opts.assetPrefix || "/assets/";
  var description = product.description || "";
  var themeCss    = (typeof opts.themeCss === "string" && opts.themeCss.length)
    ? opts.themeCss
    : assetUrl("css/main.css");

  var rendered = variants.map(function (v) {
    var price = prices[v.id];
    var priceStr = price ? fmt(price.amount_minor, price.currency) : "—";
    var vTitle = v.title || (Object.keys(v.options || {}).map(function (k) { return v.options[k]; }).join(" / ") || "Default");
    return { id: v.id, sku: v.sku, title: vTitle, price: priceStr };
  });

  // Truthful availability + shipping shape — drives the on-page badges
  // AND the JSON-LD `availability` from the same resolved values. The
  // edge handler threads `opts.inventory` (per-SKU stock map); absent it,
  // the product reads as in stock (never-block stance).
  var availability = _resolveAvailability(variants, opts.inventory);
  // An OPEN pre-order campaign for the lead SKU swaps the add-to-cart buy box
  // for the reservation CTA — mirrors the container so the dual render stays
  // consistent. The edge handler threads `opts.preorderCampaign`
  // ({ campaign, remaining_units }) from a live D1 read; the shape is built
  // here with the page's own `fmt` so the CTA prices match the buy-box prices.
  // Absent a campaign (or a non-active one), the standard buy box renders.
  var preorderShape = opts.preorderCampaign
    ? preorderCtaShape(opts.preorderCampaign.campaign, opts.preorderCampaign.remaining_units, fmt, product.slug)
    : null;
  // Multi-variant headline price — "From <lowest>"; mirrors the container.
  // Min over integer amount_minor, formatted once via `fmt` (never over
  // formatted strings). See lib/storefront.js#_buildHeadlinePrice.
  var headlinePrice = _buildHeadlinePrice(rendered, variants, prices, fmt);
  var buyboxHtml = preorderShape
    ? _buildPreorderCta(preorderShape, escapeHtml)
    : _buildBuyBox(rendered, escapeHtml, availability, headlinePrice);
  // The reserve PRG lands the shopper back on the PDP with a fixed
  // ?preorder=<reserved|unavailable|closed> marker; the banner prepends the
  // buy box. Mirrors the container so the dual render agrees on this URL.
  buyboxHtml = _buildPreorderNotice(opts.preorderNotice) + buyboxHtml;
  var availabilityHtml = _buildAvailability(availability);
  var shippingNoteHtml = _pdpShippingNote(availability);

  var galleryHtml = _buildPdpGallery(product, media, assetPrefix);
  var reviewsHtml = _buildReviews(reviewSummary, reviews, reviewForm);
  var qaHtml = _buildProductQa(qaQuestions, qaForm);
  var bundlesHtml = _buildBundles(bundleOffers);
  var qtyBreaksHtml = _buildQtyBreaks(qtyBreaks);
  var wishlistHtml = _buildWishlist(product.id, wishlistCount);
  var compareHtml = _buildCompare(product.id);
  // "You may also like" rail — same-collection picks the edge handler
  // decorated with each card's hero media + first-variant price (minor
  // units). The price string is formatted here with the page's own `fmt`
  // so it tracks the active currency context exactly as the buy-box
  // prices do. Mirrors the container renderer
  // (`lib/storefront.js#renderProduct`) so the section is byte-identical
  // across substrates.
  var relatedAssetPrefix = opts.asset_prefix || "/assets/";
  var relatedCards = (opts.related || []).map(function (r) {
    var priceStr = Number.isInteger(r.price_minor)
      ? fmt(r.price_minor, r.price_currency || "USD")
      : "—";
    return {
      slug:      r.slug,
      title:     r.title,
      price:     priceStr,
      image_url: r.hero_r2_key ? (relatedAssetPrefix + r.hero_r2_key) : null,
      image_alt: r.hero_r2_key ? (r.hero_alt_text || r.title) : null,
    };
  });
  var relatedHtml = _buildRelatedProducts(relatedCards);
  var body = renderTemplate(PRODUCT_PAGE, {
    title:        product.title,
    description:  description,
  })
    .replace("RAW_GALLERY_PLACEHOLDER", galleryHtml)
    .replace("RAW_AVAILABILITY_PLACEHOLDER", availabilityHtml)
    .replace("RAW_BUYBOX_PLACEHOLDER", buyboxHtml)
    .replace("RAW_SHIPPING_NOTE_PLACEHOLDER", shippingNoteHtml)
    .replace("RAW_QTYBREAK_PLACEHOLDER", qtyBreaksHtml)
    .replace("RAW_WISHLIST_PLACEHOLDER", wishlistHtml)
    .replace("RAW_COMPARE_PLACEHOLDER", compareHtml)
    .replace("RAW_BUNDLES_PLACEHOLDER", bundlesHtml)
    .replace("RAW_REVIEWS_PLACEHOLDER", reviewsHtml)
    .replace("RAW_QA_PLACEHOLDER", qaHtml)
    .replace("RAW_RELATED_PLACEHOLDER", relatedHtml);

  var heroMedia = media[0] || null;
  // Absolute base for the BreadcrumbList `item` URLs — origin of the PDP's
  // own canonical, falling back to the shop-name host.
  var absBase = absoluteBase(opts.canonicalUrl, shopName);
  // og:image / twitter:image / the Product JSON-LD `image` all carry a
  // FULLY-QUALIFIED URL — a relative hero path (or the brand-logo default)
  // is dropped by social-share crawlers and by Google's product rich
  // result. Absolutize once here so the JSON-LD `image` (built below) and
  // the meta tags (`_wrap` re-runs the idempotent absolutizer) match.
  var ogImage   = absolutizeOgImage(
    heroMedia ? (assetPrefix + heroMedia.r2_key) : "/assets/brand/logo.png",
    opts.canonicalUrl, shopName
  );

  // Schema.org Product JSON-LD. Surfaces in Google's product-result
  // panel (price + availability), Bing Shopping, etc. The aggregate
  // offer collapses every variant into one price band; price math
  // formats the lowest minor-unit price as a decimal string per
  // schema.org/Offer's `price` expectation.
  var priceList = variants
    .map(function (v) { return prices && prices[v.id] ? prices[v.id].amount_minor : null; })
    .filter(function (n) { return Number.isInteger(n); });
  var jsonLd = null;
  if (priceList.length > 0) {
    var lowMinor = Math.min.apply(null, priceList);
    var hiMinor  = Math.max.apply(null, priceList);
    var currency = (prices[variants[0].id] && prices[variants[0].id].currency) || "USD";
    var divisor  = currency === "JPY" || currency === "KRW" ? 1 : 100;
    // AggregateRating enriches the same product-result panel with the
    // star rating + review count. Only emitted when published reviews
    // exist — Google flags an `aggregateRating` with `reviewCount: 0`
    // as invalid structured data.
    var aggregateRating;
    if (reviewSummary && Number(reviewSummary.count) > 0) {
      aggregateRating = {
        "@type":       "AggregateRating",
        "ratingValue": (Number(reviewSummary.avg_rating) || 0).toFixed(1),
        "reviewCount": Number(reviewSummary.count),
        "bestRating":  5,
        "worstRating": 1,
      };
    }
    jsonLd = jsonLdScript({
      "@context":    "https://schema.org",
      "@type":       "Product",
      "name":        product.title,
      "description": description || ("Browse " + product.title + " on " + shopName + "."),
      "image":       heroMedia ? [ogImage] : undefined,
      "sku":         variants[0] && variants[0].sku,
      "aggregateRating": aggregateRating,
      "offers":      {
        "@type":         "AggregateOffer",
        "priceCurrency": currency,
        "lowPrice":      (lowMinor / divisor).toFixed(divisor === 1 ? 0 : 2),
        "highPrice":     (hiMinor  / divisor).toFixed(divisor === 1 ? 0 : 2),
        "offerCount":    variants.length,
        "availability":  availability.in_stock
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
      },
    });
  }

  // BreadcrumbList JSON-LD — Google's product-rich-result panel
  // shows the trail (Shop → Product) above the title. Two-position
  // breadcrumb matches the on-page `<nav class="breadcrumb">` markup
  // already in the PDP template.
  var breadcrumbJsonLd = jsonLdScript({
    "@context":        "https://schema.org",
    "@type":           "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Shop", "item": absBase + "/" },
      { "@type": "ListItem", "position": 2, "name": product.title, "item": absBase + "/products/" + product.slug },
    ],
  });
  // QAPage JSON-LD from the published Q&A (empty string when no question is
  // answered — Google rejects an answerless QAPage). Mirrors the container.
  var qaPageJsonLd = _buildQaPageJsonLd(qaQuestions);
  jsonLd = (jsonLd || "") + breadcrumbJsonLd + qaPageJsonLd;

  return _wrap({
    title:         product.title,
    shopName:      shopName,
    cartCount:     cartCount,
    searchQ:       searchQ,
    themeCss:      themeCss,
    ogType:        "product",
    ogTitle:       product.title + " — " + shopName,
    ogDescription: description || ("Browse " + product.title + " on " + shopName + "."),
    ogImage:       ogImage,
    canonicalUrl:  opts.canonicalUrl,
    ogUrl:         opts.ogUrl,
    locale:           opts.locale,
    defaultLocale:    opts.defaultLocale,
    chromeOverrides:  opts.chromeOverrides,
    host:             opts.host,
    path:             opts.path,
    supportedLocales: opts.supportedLocales,
    localeStrategy:   opts.localeStrategy,
    body:          body + (jsonLd || ""),
    announcement:        opts.announcement,
    currencyOptions:     opts.currencyOptions,
    currencySelected:    opts.currencySelected,
    currencyNote:        opts.currencyNote,
    currencyRedirectTo:  opts.currencyRedirectTo,
  });
}
