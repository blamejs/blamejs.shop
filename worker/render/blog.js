// Blog list + article-detail renderers. Composed off the same
// minimal layout the policy pages use — read-once editorial content,
// not a commerce surface. Body renders as plain text wrapped in
// <p> tags (blamejs ships markdown rendering as `b.template.render`
// but it's file-backed; inline-string body needs a separate path).
// Operators who want markdown formatting compose `b.template`
// elsewhere and pass the rendered HTML in.
import { renderTemplate, jsonLdScript, assetUrl, stylesheetIntegrityAttr, CONSENT_BANNER, consentScriptTag, announcementBar, announcementScriptTag } from "./_lib.js";
import b from "../b.js";

var LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <title>{{title}} — {{shop_name}}</title>\n" +
  "  <meta name=\"description\" content=\"{{description}}\">\n" +
  "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"/assets/brand/favicon.svg\">\n" +
  "  <link rel=\"stylesheet\" href=\"{{theme_css}}\"RAW_CSS_INTEGRITY>\n" +
  "  <link rel=\"alternate\" type=\"application/rss+xml\" href=\"/feed.xml\" title=\"{{shop_name_rss}} Blog\">\n" +
  "  <meta property=\"og:type\" content=\"{{og_type}}\">\n" +
  "  <meta property=\"og:title\" content=\"{{og_title}}\">\n" +
  "  <meta property=\"og:description\" content=\"{{og_description}}\">\n" +
  "  <meta property=\"og:image\" content=\"{{og_image}}\">\n" +
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
  "RAW_ANNOUNCEMENT_SCRIPT" +
  "</body>\n" +
  "</html>\n";

function _wrap(opts, bodyHtml) {
  var shopName = opts.shopName || "blamejs.shop";
  var themeCss = opts.themeCss || assetUrl("css/main.css");
  return renderTemplate(LAYOUT, {
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
    og_image:          opts.ogImage || "/assets/brand/logo.png",
    year:              String(new Date().getUTCFullYear()),
  }).replace("RAW_CSS_INTEGRITY", stylesheetIntegrityAttr(themeCss))
    .replace("RAW_ANNOUNCEMENT_BAR", announcementBar(opts.announcement || null))
    .replace("RAW_CONSENT_SCRIPT", consentScriptTag())
    .replace("RAW_ANNOUNCEMENT_SCRIPT", (opts.announcement && opts.announcement.dismissible) ? announcementScriptTag() : "")
    .replace("RAW_BODY_PLACEHOLDER", bodyHtml);
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

export function renderBlogList(opts) {
  opts = opts || {};
  var articles = Array.isArray(opts.articles) ? opts.articles : [];
  var shopName = opts.shopName || "blamejs.shop";
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
      author:    a.author_id,
      date:      _isoDate(a.published_at),
      lede:      lede,
    });
  }).join("\n");
  var body = heading + (articles.length === 0 ? "" : "<section class=\"blog-list\">" + cards + "</section>");
  return _wrap({
    title:       "Blog",
    description: "Editorial posts from " + shopName + ".",
    ogType:      "website",
    shopName:    shopName,
    themeCss:    opts.themeCss,
    version:     opts.version,
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
  var bodyHtml = _paragraphsFromPlainText(article.body || "");
  var articleHtml = renderTemplate(ARTICLE_TPL, {
    title:  article.title,
    author: article.author_id,
    date:   _isoDate(article.published_at),
  }).replace("RAW_BODY_HTML_PLACEHOLDER", bodyHtml);

  // Schema.org Article JSON-LD. Google's article-rich-result panel
  // reads `headline`, `datePublished`, `dateModified`, `image`,
  // `author`. The dates pass through as ISO 8601 (toISOString); the
  // image falls back to the brand logo when no hero is set.
  var jsonLd = jsonLdScript({
    "@context":      "https://schema.org",
    "@type":         "Article",
    "headline":      article.title,
    "image":         article.hero_image_url ? [article.hero_image_url] : ["/assets/brand/logo.png"],
    "datePublished": Number.isInteger(article.published_at) ? new Date(article.published_at).toISOString() : undefined,
    "dateModified":  Number.isInteger(article.updated_at)   ? new Date(article.updated_at).toISOString()   : undefined,
    "author":        { "@type": "Person", "name": article.author_id },
    "description":   article.meta_description || String(article.body || "").slice(0, 240),
  });

  return _wrap({
    title:       article.title,
    description: article.meta_description || (String(article.body || "").slice(0, 240)),
    ogType:      "article",
    ogImage:     article.hero_image_url || "/assets/brand/logo.png",
    shopName:    shopName,
    themeCss:    opts.themeCss,
    version:     opts.version,
  }, articleHtml + jsonLd);
}
