// Blog list + article-detail renderers. Composed off the same
// minimal layout the policy pages use — read-once editorial content,
// not a commerce surface. Body renders as plain text wrapped in
// <p> tags (blamejs ships markdown rendering as `b.template.render`
// but it's file-backed; inline-string body needs a separate path).
// Operators who want markdown formatting compose `b.template`
// elsewhere and pass the rendered HTML in.
import { renderTemplate, jsonLdScript, assetUrl, stylesheetIntegrityAttr, CONSENT_BANNER, consentScriptTag, cartCountScriptTag, announcementBar, announcementScriptTag, spliceRaw, absolutizeOgImage } from "./_lib.js";
import b from "../b.js";

var LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <title>{{title}} — {{shop_name}}</title>\n" +
  "  <meta name=\"description\" content=\"{{description}}\">\n" +
  "  <link rel=\"canonical\" href=\"{{canonical_url}}\">\n" +
  "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"/assets/brand/favicon.svg\">\n" +
  "  <link rel=\"icon\" type=\"image/png\" href=\"/assets/brand/favicon.png\">\n" +
  "  <link rel=\"apple-touch-icon\" href=\"/assets/brand/favicon.png\">\n" +
  "  <meta name=\"theme-color\" content=\"#08080a\">\n" +
  "  <link rel=\"stylesheet\" href=\"{{theme_css}}\"RAW_CSS_INTEGRITY>\n" +
  "  <link rel=\"alternate\" type=\"application/rss+xml\" href=\"/feed.xml\" title=\"{{shop_name_rss}} Blog\">\n" +
  "  <meta property=\"og:type\" content=\"{{og_type}}\">\n" +
  "  <meta property=\"og:title\" content=\"{{og_title}}\">\n" +
  "  <meta property=\"og:description\" content=\"{{og_description}}\">\n" +
  "  <meta property=\"og:image\" content=\"{{og_image}}\">\n" +
  "  <meta property=\"og:url\" content=\"{{canonical_url}}\">\n" +
  "</head>\n" +
  "<body>\n" +
  "  <a class=\"skip-link\" href=\"#main\">Skip to content</a>\n" +
  "RAW_ANNOUNCEMENT_BAR" +
  "  <header class=\"site-header\">\n" +
  "    <div class=\"site-header__inner\">\n" +
  "      <a href=\"/\" class=\"brand\" aria-label=\"{{shop_name_brand}}\"><img src=\"/assets/brand/logo.png\" alt=\"{{shop_name_brand}}\"></a>\n" +
  "      <nav class=\"site-nav\" aria-label=\"Primary\">\n" +
  "        <a class=\"site-nav__link\" href=\"/\">Shop</a>\n" +
  "        <a class=\"site-nav__link\" href=\"/blog\">Blog</a>\n" +
  "        <a class=\"site-nav__link\" href=\"/cart\">Cart</a>\n" +
  "      </nav>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "  <main id=\"main\" class=\"blog-page\">\n" +
  "    <div class=\"blog-page__inner\">\n" +
  "      RAW_BODY_PLACEHOLDER\n" +
  "    </div>\n" +
  "  </main>\n" +
  "  <footer class=\"site-footer site-footer--minimal\">\n" +
  "    <div class=\"site-footer__inner\">\n" +
  "      <p>&copy; {{year}} {{shop_name_footer}}</p>\n" +
  "      <ul>\n" +
  "        <li><a href=\"/privacy\">Privacy</a></li>\n" +
  "        <li><a href=\"/terms\">Terms</a></li>\n" +
  "        <li><a href=\"/cookies\">Manage cookies</a></li>\n" +
  "        <li><a href=\"/feed.xml\">RSS</a></li>\n" +
  "      </ul>\n" +
  "    </div>\n" +
  "  </footer>\n" +
  CONSENT_BANNER +
  "RAW_CONSENT_SCRIPT" +
  "RAW_CART_COUNT_SCRIPT" +
  "RAW_ANNOUNCEMENT_SCRIPT" +
  "</body>\n" +
  "</html>\n";

function _wrap(opts, bodyHtml) {
  var shopName = opts.shopName || "blamejs.shop";
  var themeCss = opts.themeCss || assetUrl("css/main.css");
  // og:image / twitter:image carry a FULLY-QUALIFIED URL — a relative
  // `/assets/...` value (the blog-list brand default, or an article hero
  // already absolutized at its own site) is dropped by social-share
  // crawlers and by Google's rich result. Absolutize here so both the blog
  // LIST and the article pages emit an absolute share image; the article's
  // pre-absolutized value is idempotent.
  var ogImage = absolutizeOgImage(opts.ogImage || "/assets/brand/logo.png", opts.canonicalUrl, shopName);
  var wrapped = renderTemplate(LAYOUT, {
    title:             opts.title,
    shop_name:         shopName,
    shop_name_rss:     shopName,
    shop_name_brand:   shopName,
    shop_name_footer:  shopName,
    description:       opts.description,
    theme_css:         themeCss,
    og_type:           opts.ogType || "website",
    og_title:          (opts.title || shopName) + " — " + shopName,
    og_description:    opts.description,
    og_image:          ogImage,
    canonical_url:     opts.canonicalUrl || "",
    year:              String(new Date().getUTCFullYear()),
  }).replace("RAW_CSS_INTEGRITY", stylesheetIntegrityAttr(themeCss))
    .replace("RAW_CONSENT_SCRIPT", consentScriptTag())
    .replace("RAW_CART_COUNT_SCRIPT", cartCountScriptTag())
    .replace("RAW_ANNOUNCEMENT_SCRIPT", (opts.announcement && opts.announcement.dismissible) ? announcementScriptTag() : "");
  // The announcement bar carries operator-supplied message text (HTML-
  // escaped, but `$` is not an escaped character), so splice it via the
  // replacer-function helper — a `$&` / `` $` `` / `$N` in the message must
  // land literally, not trigger `String.replace`'s dollar substitution.
  // Same for the article/list body below. See `spliceRaw`.
  wrapped = spliceRaw(wrapped, "RAW_ANNOUNCEMENT_BAR", announcementBar(opts.announcement || null));
  return spliceRaw(wrapped, "RAW_BODY_PLACEHOLDER", bodyHtml);
}

function _isoDate(epochMs) {
  if (!Number.isInteger(epochMs)) return "";
  return new Date(epochMs).toISOString().slice(0, 10);
}

// Plain body text → HTML paragraphs. Splits on blank lines; escapes
// each paragraph via b.template.escapeHtml; wraps in <p>. Markdown
// is intentionally NOT interpreted at the edge — operators who want
// markdown rendering compose `b.template` upstream and store the
// rendered HTML, OR the body column carries pre-escaped HTML that
// the storefront passes through.
function _paragraphsFromPlainText(body) {
  if (typeof body !== "string") return "";
  return body.split(/\n\s*\n/).map(function (para) {
    var trimmed = para.trim();
    if (trimmed.length === 0) return "";
    return "<p>" + b.template.escapeHtml(trimmed).replace(/\n/g, "<br>") + "</p>";
  }).filter(Boolean).join("\n");
}

var ARTICLE_CARD_TPL =
  "<article class=\"blog-card\">\n" +
  "  <h3 class=\"blog-card__title\"><a href=\"/blog/{{slug_href}}\">{{title}}</a></h3>\n" +
  "  <p class=\"blog-card__meta\">By {{author}} · {{date}}</p>\n" +
  "  <p class=\"blog-card__lede\">{{lede}}</p>\n" +
  "  <a class=\"blog-card__cta\" href=\"/blog/{{slug_cta}}\">Read more →</a>\n" +
  "</article>\n";

// `/blog?page=N` URL for a given 1-based page. Page 1 is the bare
// `/blog` URL so the index has one canonical address; later pages carry
// the `?page=` param. Mirrors the search/collection renderers' page-URL
// helpers (page 1 omits the param).
function _blogPageUrl(page) {
  return page <= 1 ? "/blog" : "/blog?page=" + page;
}

// Prev/next pagination for the blog index. The blog data layer
// (`listBlogArticles`) is offset-paginated and exposes no total, so the
// nav is a prev/next pair — the collection-page shape — not the numbered
// `/search` UI. Reuses the `search-pagination` shell + `rel="prev"/"next"`
// + disabled-state spans so no new CSS ships. Renders nothing when there
// is neither a previous page (page 1) nor a next page (`hasNext` false) —
// a single-page blog stays byte-identical to the unpaginated render.
// `hasNext` is the route's peek-one-past-the-page result, so the last
// page never links to an empty one.
function _renderBlogPagination(page, hasNext) {
  var cur = page > 1 ? page : 1;
  var hasPrev = cur > 1;
  if (!hasPrev && !hasNext) return "";
  var prev = hasPrev
    ? renderTemplate("<a class=\"search-pagination__link search-pagination__prev\" href=\"{{href}}\" rel=\"prev\">Previous</a>\n",
        { href: _blogPageUrl(cur - 1) })
    : "<span class=\"search-pagination__link search-pagination__prev is-disabled\" aria-disabled=\"true\">Previous</span>\n";
  var next = hasNext
    ? renderTemplate("<a class=\"search-pagination__link search-pagination__next\" href=\"{{href}}\" rel=\"next\">Next</a>\n",
        { href: _blogPageUrl(cur + 1) })
    : "<span class=\"search-pagination__link search-pagination__next is-disabled\" aria-disabled=\"true\">Next</span>\n";
  return "<nav class=\"search-pagination blog-pagination\" aria-label=\"Blog pages\">\n" +
    prev +
    next +
    "</nav>\n";
}

export function renderBlogList(opts) {
  opts = opts || {};
  var articles = Array.isArray(opts.articles) ? opts.articles : [];
  var shopName = opts.shopName || "blamejs.shop";
  // The byline shows the shop name, never the raw internal `author_id`
  // (an operator/user id, not a public display name). The blog model
  // carries no author display-name column, so the shop name is the
  // cleanest non-leaking source.
  var byline   = b.template.escapeHtml(shopName);
  var page     = (typeof opts.page === "number" && opts.page > 1) ? Math.floor(opts.page) : 1;
  var hasNext  = !!opts.hasNext;
  var heading = articles.length === 0
    ? "<section class=\"blog-empty\"><p class=\"eyebrow\">Blog</p><h1>No posts yet.</h1><p>The blog is open but nothing's been published yet. Check back, or subscribe to the <a href=\"/feed.xml\">RSS feed</a>.</p></section>"
    : "<section class=\"blog-list-head\"><p class=\"eyebrow\">Blog</p><h1>" + b.template.escapeHtml(shopName) + " blog</h1><p>Editorial posts from the operator. <a href=\"/feed.xml\">RSS feed</a>.</p></section>";
  var cards = articles.map(function (a) {
    var slugEnc = encodeURIComponent(a.slug);
    var lede    = a.meta_description != null && a.meta_description.length > 0
      ? a.meta_description
      : String(a.body || "").slice(0, 240);
    return renderTemplate(ARTICLE_CARD_TPL, {
      slug_href: slugEnc,
      slug_cta:  slugEnc,
      title:     a.title,
      author:    byline,
      date:      _isoDate(a.published_at),
      lede:      lede,
    });
  }).join("\n");
  var pager = articles.length === 0 ? "" : _renderBlogPagination(page, hasNext);
  var body = heading +
    (articles.length === 0 ? "" : "<section class=\"blog-list\">" + cards + "</section>") +
    pager;
  return _wrap({
    title:        "Blog",
    description:  "Editorial posts from " + shopName + ".",
    ogType:       "website",
    shopName:     shopName,
    themeCss:     opts.themeCss,
    version:      opts.version,
    canonicalUrl: opts.canonicalUrl,
  }, body);
}

var ARTICLE_TPL =
  "<article class=\"blog-article\">\n" +
  "  <header class=\"blog-article__head\">\n" +
  "    <p class=\"eyebrow\">Blog</p>\n" +
  "    <h1>{{title}}</h1>\n" +
  "    <p class=\"blog-article__meta\">By {{author}} · {{date}}</p>\n" +
  "  </header>\n" +
  "  <div class=\"blog-article__body\">\n" +
  "    RAW_BODY_HTML_PLACEHOLDER" +
  "  </div>\n" +
  "  <footer class=\"blog-article__foot\">\n" +
  "    <a href=\"/blog\">← Back to blog</a>\n" +
  "  </footer>\n" +
  "</article>\n";

export function renderBlogArticle(opts) {
  opts = opts || {};
  var article = opts.article;
  if (!article || typeof article !== "object") {
    throw new TypeError("renderBlogArticle: opts.article required");
  }
  var shopName = opts.shopName || "blamejs.shop";
  // The byline shows the shop name, never the raw internal `author_id`
  // (an operator/user id, not a public display name). The blog model
  // carries no author display-name column, so the shop name is the
  // cleanest non-leaking source — surfaced in both the on-page byline
  // and the Article JSON-LD author Google reads.
  var byline   = shopName;
  var bodyHtml = _paragraphsFromPlainText(article.body || "");
  // Splice the rendered body paragraphs literally so a `$`-bearing post
  // body can't trip `String.replace`'s dollar substitution. See `spliceRaw`.
  var articleHtml = spliceRaw(renderTemplate(ARTICLE_TPL, {
    title:  article.title,
    author: byline,
    date:   _isoDate(article.published_at),
  }), "RAW_BODY_HTML_PLACEHOLDER", bodyHtml);

  // Schema.org Article JSON-LD. Google's article-rich-result panel
  // reads `headline`, `datePublished`, `dateModified`, `image`,
  // `author`. The dates pass through as ISO 8601 (toISOString); the
  // image falls back to the brand logo when no hero is set. The `image`
  // + the og:image carry a FULLY-QUALIFIED URL — a relative hero/default
  // path is dropped by Google's rich result and by social-share crawlers,
  // so absolutize once against the page origin (`_wrap` re-runs the
  // idempotent absolutizer for the meta tag).
  var ogImage = absolutizeOgImage(
    article.hero_image_url || "/assets/brand/logo.png",
    opts.canonicalUrl, shopName
  );
  var jsonLd = jsonLdScript({
    "@context":      "https://schema.org",
    "@type":         "Article",
    "headline":      article.title,
    "image":         [ogImage],
    "datePublished": Number.isInteger(article.published_at) ? new Date(article.published_at).toISOString() : undefined,
    "dateModified":  Number.isInteger(article.updated_at)   ? new Date(article.updated_at).toISOString()   : undefined,
    "author":        { "@type": "Organization", "name": byline },
    "description":   article.meta_description || String(article.body || "").slice(0, 240),
  });

  return _wrap({
    title:        article.title,
    description:  article.meta_description || (String(article.body || "").slice(0, 240)),
    ogType:       "article",
    ogImage:      ogImage,
    shopName:     shopName,
    themeCss:     opts.themeCss,
    version:      opts.version,
    canonicalUrl: opts.canonicalUrl,
  }, articleHtml + jsonLd);
}
