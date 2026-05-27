import { renderTemplate, escapeHtml, escapeAttr, jsonLdScript, assetUrl, stylesheetIntegrityAttr, CONSENT_BANNER, consentScriptTag, makeFormatPrice, currencySwitcher } from "./_lib.js";

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
  "          <li><a href=\"/categories\">Categories</a></li>\n" +
  "          <li><a href=\"/?sort=new\">New arrivals</a></li>\n" +
  "          <li><a href=\"/?sort=sale\">On sale</a></li>\n" +
  "          <li><a href=\"/compare\">Compare</a></li>\n" +
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
  "    RAW_CURRENCY_SWITCHER\n" +
  "    <div class=\"site-footer__copy\">\n" +
  "      <p>&copy; {{year}} {{shop_name}} — built on blamejs · Apache 2.0 licensed.</p>\n" +
  "      <ul>\n" +
  "        <li><a href=\"/SECURITY.md\">Security</a></li>\n" +
  "        <li><a href=\"/privacy\">Privacy</a></li>\n" +
  "        <li><a href=\"/terms\">Terms</a></li>\n" +
  "        <li><a href=\"/cookies\">Manage cookies</a></li>\n" +
  "      </ul>\n" +
  "    </div>\n" +
  "  </footer>\n" +
  CONSENT_BANNER +
  "RAW_CONSENT_SCRIPT" +
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
  "      RAW_QTYBREAK_PLACEHOLDER\n" +
  "      RAW_WISHLIST_PLACEHOLDER\n" +
  "      RAW_COMPARE_PLACEHOLDER\n" +
  "    </div>\n" +
  "  </div>\n" +
  "  RAW_BUNDLES_PLACEHOLDER\n" +
  "  RAW_REVIEWS_PLACEHOLDER\n" +
  "  RAW_QA_PLACEHOLDER\n" +
  "</section>\n";

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
  }).replace("RAW_CSS_INTEGRITY", stylesheetIntegrityAttr(opts.themeCss))
    .replace("RAW_CONSENT_SCRIPT", consentScriptTag())
    .replace("RAW_CURRENCY_SWITCHER", currencySwitcher({
      currencies:  opts.currencyOptions,
      selected:    opts.currencySelected,
      note:        opts.currencyNote,
      redirect_to: opts.currencyRedirectTo,
    }))
    .replace("RAW_BODY_PLACEHOLDER", opts.body);
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

  var rows = rendered.map(function (v) {
    return renderTemplate(VARIANT_ROW, { title: v.title, sku: v.sku, price: v.price, variant_id: v.id });
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"4\" class=\"empty\">No variants available.</td></tr>";

  var galleryHtml = _buildPdpGallery(product, media, assetPrefix);
  var reviewsHtml = _buildReviews(reviewSummary, reviews, reviewForm);
  var qaHtml = _buildProductQa(qaQuestions, qaForm);
  var bundlesHtml = _buildBundles(bundleOffers);
  var qtyBreaksHtml = _buildQtyBreaks(qtyBreaks);
  var wishlistHtml = _buildWishlist(product.id, wishlistCount);
  var compareHtml = _buildCompare(product.id);
  var body = renderTemplate(PRODUCT_PAGE, {
    title:        product.title,
    description:  description,
    variant_rows: "RAW_ROWS_PLACEHOLDER",
  })
    .replace("RAW_GALLERY_PLACEHOLDER", galleryHtml)
    .replace("RAW_ROWS_PLACEHOLDER", rows)
    .replace("RAW_QTYBREAK_PLACEHOLDER", qtyBreaksHtml)
    .replace("RAW_WISHLIST_PLACEHOLDER", wishlistHtml)
    .replace("RAW_COMPARE_PLACEHOLDER", compareHtml)
    .replace("RAW_BUNDLES_PLACEHOLDER", bundlesHtml)
    .replace("RAW_REVIEWS_PLACEHOLDER", reviewsHtml)
    .replace("RAW_QA_PLACEHOLDER", qaHtml);

  var heroMedia = media[0] || null;
  var ogImage   = heroMedia ? (assetPrefix + heroMedia.r2_key) : "/assets/brand/logo.png";

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
        "availability":  "https://schema.org/InStock",
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
      { "@type": "ListItem", "position": 1, "name": "Shop", "item": "/" },
      { "@type": "ListItem", "position": 2, "name": product.title, "item": "/products/" + product.slug },
    ],
  });
  jsonLd = (jsonLd || "") + breadcrumbJsonLd;

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
    body:          body + (jsonLd || ""),
    currencyOptions:     opts.currencyOptions,
    currencySelected:    opts.currencySelected,
    currencyNote:        opts.currencyNote,
    currencyRedirectTo:  opts.currencyRedirectTo,
  });
}
