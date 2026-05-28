import { renderTemplate, assetUrl, stylesheetIntegrityAttr, CONSENT_BANNER, consentScriptTag, cartCountScriptTag, announcementBar, announcementScriptTag, makeFormatPrice, currencySwitcher } from "./_lib.js";
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
  "        <h4>{{footer_shop_heading}}</h4>\n" +
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
  "        <h4>{{footer_framework_heading}}</h4>\n" +
  "        <ul>\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">{{footer_framework_source}}</a></li>\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs\" rel=\"noopener\">{{footer_framework_core}}</a></li>\n" +
  "          <li><a href=\"/SECURITY.md\">{{footer_framework_security}}</a></li>\n" +
  "          <li><a href=\"/CHANGELOG.md\">{{footer_framework_changelog}}</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h4>{{footer_operators_heading}}</h4>\n" +
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
  "<div class=\"card\">\n" +
  "  <h2>{{title}}</h2>\n" +
  "  <p class=\"price\">{{price}}</p>\n" +
  "  <a href=\"/products/{{slug}}\" class=\"card-link\">View product →</a>\n" +
  "</div>\n";

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
  "    <p class=\"search-empty__icon\" aria-hidden=\"true\"><svg class=\"empty-illu\" viewBox=\"0 0 200 132\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"90\" cy=\"58\" r=\"30\"/><path d=\"M112 80 L132 100\"/><path d=\"M80 52 L86 58 L80 64\" stroke=\"currentColor\" stroke-width=\"2.4\"/><path d=\"M92 64 H102\" stroke=\"currentColor\" stroke-width=\"2.4\"/><circle cx=\"46\" cy=\"34\" r=\"2\" fill=\"#732A8D\" stroke=\"none\"/><circle cx=\"146\" cy=\"44\" r=\"2\" fill=\"#732A8D\" stroke=\"none\"/></svg></p>\n" +
  "    <h2>{{heading}}</h2>\n" +
  "    <p>{{copy}}</p>\n" +
  "    {{clear_link}}\n" +
  "    <a href=\"/\" class=\"btn-ghost\">Browse the full catalog</a>\n" +
  "  </div>\n" +
  "</section>\n";

var SEARCH_CORRECTION =
  "<p class=\"search-correction\">Showing results for <strong>{{correction}}</strong>.</p>\n";

var FACET_GROUP_HEAD =
  "<fieldset class=\"facet-group\">\n" +
  "  <legend class=\"facet-group__title\">{{label}}</legend>\n" +
  "  <ul class=\"facet-group__options\">\n";

var FACET_OPTION =
  "<li class=\"facet-option\">\n" +
  "  <a class=\"facet-option__link{{selected_class}}\" href=\"{{href}}\" rel=\"nofollow\"{{aria_current}}>\n" +
  "    <span class=\"facet-option__box\" aria-hidden=\"true\">{{box}}</span>{{selected_cue}}\n" +
  "    <span class=\"facet-option__label\">{{label}}</span>\n" +
  "    <span class=\"facet-option__count\">{{count}}</span>\n" +
  "  </a>\n" +
  "</li>\n";

var FACET_CHIP =
  "<a class=\"facet-chip\" href=\"{{href}}\" rel=\"nofollow\">\n" +
  "  <span class=\"facet-chip__label\">{{label}}</span>\n" +
  "  <span class=\"facet-chip__x\" aria-hidden=\"true\">×</span>\n" +
  "  <span class=\"skip-link\">Remove filter</span>\n" +
  "</a>\n";

// Build a `/search?...` URL string from a query + applied-filters map.
// `filters` is `{ facetKey: [value, ...] }`. The URLSearchParams
// percent-encodes every value; the renderer HTML-escapes the result
// when it lands in an `href` attribute.
function _searchUrl(q, filters) {
  var sp = new URLSearchParams();
  if (typeof q === "string" && q.length) sp.set("q", q);
  var keys = Object.keys(filters).sort();
  for (var i = 0; i < keys.length; i += 1) {
    var vals = filters[keys[i]] || [];
    var sorted = vals.slice().sort();
    for (var j = 0; j < sorted.length; j += 1) sp.append(keys[i], sorted[j]);
  }
  var qs = sp.toString();
  return qs.length ? "/search?" + qs : "/search";
}

// Clone an applied-filters map with one value toggled on/off for a
// facet key. Returns a fresh object (never mutates the input).
function _toggleFilter(filters, key, value) {
  var next = {};
  var keys = Object.keys(filters);
  for (var i = 0; i < keys.length; i += 1) next[keys[i]] = filters[keys[i]].slice();
  var cur = next[key] || [];
  var at = cur.indexOf(value);
  if (at === -1) {
    cur = cur.concat([value]);
  } else {
    cur = cur.slice(0, at).concat(cur.slice(at + 1));
  }
  if (cur.length) next[key] = cur;
  else delete next[key];
  return next;
}

function _renderFacets(facets, filters, q) {
  var groups = [];
  for (var f = 0; f < facets.length; f += 1) {
    var facet = facets[f];
    var optionsHtml = "";
    var rendered = 0;
    for (var o = 0; o < facet.options.length; o += 1) {
      var opt = facet.options[o];
      // Hide zero-count options that aren't already selected — they'd
      // lead to an empty result set and clutter the chrome.
      if (opt.count === 0 && !opt.selected) continue;
      var toggled = _toggleFilter(filters, facet.key, opt.value);
      optionsHtml += renderTemplate(FACET_OPTION, {
        href:           _searchUrl(q, toggled),
        selected_class: opt.selected ? " is-selected" : "",
        aria_current:   "RAW_ARIA",
        box:            opt.selected ? "✓" : "",
        selected_cue:   "RAW_CUE",
        label:          opt.label,
        count:          String(opt.count),
      }).replace("RAW_ARIA", opt.selected ? " aria-current=\"true\"" : "")
        .replace("RAW_CUE", opt.selected ? "<span class=\"sr-only\">Selected: </span>" : "");
      rendered += 1;
    }
    if (rendered === 0) continue;
    groups.push(
      renderTemplate(FACET_GROUP_HEAD, { label: facet.label }) +
      optionsHtml +
      "  </ul>\n</fieldset>\n"
    );
  }
  if (!groups.length) return "";
  return "<aside class=\"search-facets\" aria-label=\"Filter results\">\n" +
    "<h2 class=\"search-facets__title\">Filter</h2>\n" +
    groups.join("") +
    "</aside>\n";
}

// Active-filter chips with one-click removal. Each chip clears just its
// own value; the leading "Clear all" link drops every facet but keeps
// the query.
function _renderActiveChips(facets, filters, q) {
  var labelFor = {};
  for (var f = 0; f < facets.length; f += 1) {
    var byVal = {};
    for (var o = 0; o < facets[f].options.length; o += 1) byVal[facets[f].options[o].value] = facets[f].options[o].label;
    labelFor[facets[f].key] = { group: facets[f].label, values: byVal };
  }
  var chips = "";
  var any = false;
  var keys = Object.keys(filters).sort();
  for (var k = 0; k < keys.length; k += 1) {
    var meta = labelFor[keys[k]];
    var vals = filters[keys[k]] || [];
    for (var v = 0; v < vals.length; v += 1) {
      var valLabel = meta && meta.values[vals[v]] != null ? meta.values[vals[v]] : vals[v];
      var groupLabel = meta ? meta.group : keys[k];
      chips += renderTemplate(FACET_CHIP, {
        href:  _searchUrl(q, _toggleFilter(filters, keys[k], vals[v])),
        label: groupLabel + ": " + valLabel,
      });
      any = true;
    }
  }
  if (!any) return "";
  var clearAll = renderTemplate(
    "<a class=\"facet-chip facet-chip--clear\" href=\"{{href}}\" rel=\"nofollow\">Clear all filters</a>\n",
    { href: _searchUrl(q, {}) }
  );
  return "<div class=\"search-active-filters\" aria-label=\"Active filters\">\n" + chips + clearAll + "</div>\n";
}

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

export function renderSearch(opts) {
  if (!opts || typeof opts.q !== "string") {
    throw new TypeError("renderSearch: opts.q (string) required");
  }
  if (!Array.isArray(opts.products)) {
    throw new TypeError("renderSearch: opts.products (array) required");
  }
  if (typeof opts.version !== "string" || opts.version.length === 0) { // allow:inline-require-non-empty-string-validation — the TypeError message must literally contain "opts.version" so the worker-render contract surfaces the offending field; the framework helper produces a `code`-first TypeError that obscures the label
    throw new TypeError("renderSearch: opts.version (non-empty string) required");
  }
  var products = opts.products;
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
  // Facet chrome — facets is the computed group/option/count list,
  // filters the validated applied-filters map. Both default to
  // empty so a deploy that hasn't authored any facets renders the
  // plain product grid exactly as before.
  var facets  = Array.isArray(opts.facets) ? opts.facets : [];
  var filters = (opts.filters && typeof opts.filters === "object") ? opts.filters : {};
  var hasFilters = Object.keys(filters).length > 0;

  // "Showing results for <correction>" — surfaced when synonym /
  // typo rewrite changed what the shopper typed and there are matches.
  var correctionHtml = "";
  if (qTrim.length > 0 && typeof opts.correctedQuery === "string" &&
      opts.correctedQuery.length > 0 && opts.correctedQuery !== qTrim) {
    correctionHtml = renderTemplate(SEARCH_CORRECTION, { correction: opts.correctedQuery });
  }

  var facetsHtml = (qTrim.length > 0) ? _renderFacets(facets, filters, opts.q) : "";
  var chipsHtml  = (qTrim.length > 0) ? _renderActiveChips(facets, filters, opts.q) : "";

  var header = renderTemplate(SEARCH_HEADER, { title: title, summary: summary });
  var resultsInner;
  if (products.length === 0) {
    // When facets are active, give a path back to the unfiltered
    // query rather than only "browse the catalog".
    var clearLink = hasFilters
      ? renderTemplate(
          "<a href=\"{{href}}\" class=\"btn-ghost\">Clear filters</a>",
          { href: _searchUrl(opts.q, {}) }
        )
      : "";
    resultsInner = renderTemplate(SEARCH_EMPTY, { heading: emptyHeading, copy: emptyCopy, clear_link: "RAW_CLEAR" })
      .replace("RAW_CLEAR", clearLink);
  } else {
    var assetPrefix = typeof opts.assetPrefix === "string" ? opts.assetPrefix : "/assets/";
    var fmt = makeFormatPrice(opts.currencyContext);
    var cards = products.map(function (p) {
      var priceStr = p.starting_price_minor != null
        ? fmt(p.starting_price_minor, p.starting_price_currency || "USD")
        : "—";
      var imageUrl = p.hero_media ? assetPrefix + p.hero_media.r2_key : null;
      var imageAlt = p.hero_media ? (p.hero_media.alt_text || p.title) : null;
      return _buildProductCard({
        title:     p.title,
        price:     priceStr,
        slug:      p.slug,
        image_url: imageUrl,
        image_alt: imageAlt,
      });
    }).join("\n");
    resultsInner = "<section class=\"search-grid\"><div class=\"grid\">" + cards + "</div></section>";
  }
  var body;
  if (facetsHtml.length > 0) {
    body = header + correctionHtml + chipsHtml +
      "<div class=\"search-layout\">" + facetsHtml +
      "<div class=\"search-layout__results\">" + resultsInner + "</div></div>";
  } else {
    body = header + correctionHtml + chipsHtml + resultsInner;
  }
  var shopName = opts.shopName || "blamejs.shop";
  // Per-page meta description: a query echoes "Results for 'q'…", a blank
  // search box gets a browse prompt. Mirrors the container renderer.
  var metaDescription = qTrim.length > 0
    ? ("Results for “" + qTrim + "” in the " + shopName + " catalog.")
    : ("Search the " + shopName + " catalog by title, SKU, or description.");
  return _wrap({
    title:      "Search",
    shop_name:  shopName,
    cart_count: opts.cartCount == null ? 0 : opts.cartCount,
    search_q:   opts.q,
    theme_css:  opts.themeCss,
    og_title:   "Search — " + shopName,
    og_description: metaDescription,
    canonical_url:  opts.canonicalUrl,
    og_url:         opts.ogUrl,
    version:    opts.version,
    locale:           opts.locale,
    default_locale:   opts.defaultLocale,
    chrome_overrides: opts.chromeOverrides,
    body:       body,
    announcement:         opts.announcement,
    currency_options:     opts.currencyOptions,
    currency_selected:    opts.currencySelected,
    currency_note:        opts.currencyNote,
    currency_redirect_to: opts.currencyRedirectTo,
  });
}
