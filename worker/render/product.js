import { renderTemplate, escapeAttr, formatPrice } from "./_lib.js";

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

function _wrap(opts) {
  var shopName      = opts.shopName || "blamejs.shop";
  var ogType        = opts.ogType        || "website";
  var ogTitle       = opts.ogTitle       || (opts.title ? opts.title + " — " + shopName : shopName);
  var ogDescription = opts.ogDescription || "Open-source ecommerce framework built on blamejs. Server-rendered HTML, post-quantum crypto, zero npm runtime dependencies.";
  var ogImage       = opts.ogImage       || "/assets/brand/logo.png";
  var ogUrl         = opts.ogUrl         || "";
  return renderTemplate(LAYOUT, {
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
    body:           "RAW_BODY_PLACEHOLDER",
  }).replace("RAW_BODY_PLACEHOLDER", opts.body);
}

function _buildPdpGallery(product, media, assetPrefix) {
  var prefix = assetPrefix || "/assets/";
  if (!media || media.length === 0) {
    var initial = (product.title || "?").trim().charAt(0).toUpperCase() || "?";
    return "<figure class=\"pdp__media\" aria-hidden=\"true\">" +
             "<span class=\"pdp__media-mark\">" + escapeAttr(initial) + "</span>" +
           "</figure>" +
           "<ul class=\"pdp__thumbs\" aria-hidden=\"true\">" +
             "<li class=\"is-active\"></li><li></li><li></li><li></li>" +
           "</ul>";
  }
  var hero = media[0];
  var heroUrl = prefix + hero.r2_key;
  var heroAlt = hero.alt_text || product.title || "Product image";
  var heroImg = "<figure class=\"pdp__media pdp__media--image\">" +
                  "<img src=\"" + escapeAttr(heroUrl) + "\" alt=\"" + escapeAttr(heroAlt) + "\" loading=\"eager\">" +
                "</figure>";
  var thumbs = ["<li class=\"is-active\">" +
                  "<img src=\"" + escapeAttr(heroUrl) + "\" alt=\"\">" +
                "</li>"];
  for (var i = 1; i < Math.min(media.length, 4); i += 1) {
    var t = media[i];
    var tUrl = prefix + t.r2_key;
    thumbs.push("<li><img src=\"" + escapeAttr(tUrl) + "\" alt=\"\"></li>");
  }
  while (thumbs.length < 4) thumbs.push("<li></li>");
  return heroImg + "<ul class=\"pdp__thumbs\" aria-hidden=\"true\">" + thumbs.join("") + "</ul>";
}

export function renderProduct(opts) {
  if (!opts || !opts.product) throw new TypeError("renderProduct: opts.product required");
  if (!opts.variants) throw new TypeError("renderProduct: opts.variants required");
  if (!opts.prices) throw new TypeError("renderProduct: opts.prices required");
  var product     = opts.product;
  var variants    = opts.variants;
  var prices      = opts.prices;
  var media       = opts.media || [];
  var shopName    = opts.shopName || "blamejs.shop";
  var cartCount   = opts.cartCount == null ? 0 : opts.cartCount;
  var searchQ     = opts.searchQ == null ? "" : opts.searchQ;
  var assetPrefix = opts.assetPrefix || "/assets/";
  var description = product.description || "";
  var themeCss    = (typeof opts.themeCss === "string" && opts.themeCss.length)
    ? opts.themeCss
    : (assetPrefix + "themes/default/css/main.css?v=" + opts.version);

  var rendered = variants.map(function (v) {
    var price = prices[v.id];
    var priceStr = price ? formatPrice(price.amount_minor, price.currency) : "—";
    var vTitle = v.title || (Object.keys(v.options || {}).map(function (k) { return v.options[k]; }).join(" / ") || "Default");
    return { id: v.id, sku: v.sku, title: vTitle, price: priceStr };
  });

  var rows = rendered.map(function (v) {
    return renderTemplate(VARIANT_ROW, { title: v.title, sku: v.sku, price: v.price, variant_id: v.id });
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"4\" class=\"empty\">No variants available.</td></tr>";

  var galleryHtml = _buildPdpGallery(product, media, assetPrefix);
  var body = renderTemplate(PRODUCT_PAGE, {
    title:        product.title,
    description:  description,
    variant_rows: "RAW_ROWS_PLACEHOLDER",
  })
    .replace("RAW_GALLERY_PLACEHOLDER", galleryHtml)
    .replace("RAW_ROWS_PLACEHOLDER", rows);

  var heroMedia = media[0] || null;
  var ogImage   = heroMedia ? (assetPrefix + heroMedia.r2_key) : "/assets/brand/logo.png";

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
    ogUrl:         "",
    body:          body,
  });
}
