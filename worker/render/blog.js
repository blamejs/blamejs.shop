// Blog list + article-detail renderers. Composed off the same
// minimal layout the policy pages use — read-once editorial content,
// not a commerce surface. The article body is authored in the Markdown
// subset blogArticles.renderHtml documents (headings, lists, blockquote,
// rule, inline code / bold / italic, https-or-rooted links) and rendered
// to sanitized HTML here by a byte-for-byte port of that primitive's
// renderer, so the edge-served post matches the lib's output exactly.
import { renderTemplate, jsonLdScript, assetUrl, stylesheetIntegrityAttr, CONSENT_BANNER, consentScriptTag, cartCountScriptTag, announcementBar, announcementScriptTag, spliceRaw, absolutizeOgImage } from "./_lib.js";
import { dirFor, alternateLinks } from "./chrome-i18n.js";
import b from "../b.js";

var LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"{{lang}}\" dir=\"{{dir}}\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <title>{{title}} — {{shop_name}}</title>\n" +
  "  <meta name=\"description\" content=\"{{description}}\">\n" +
  "  <link rel=\"canonical\" href=\"{{canonical_url}}\">\n" +
  "RAW_HREFLANG" +
  "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"/assets/brand/favicon.svg\">\n" +
  "  <link rel=\"icon\" type=\"image/png\" href=\"/assets/brand/favicon.png\">\n" +
  "  <link rel=\"apple-touch-icon\" href=\"/assets/brand/favicon.png\">\n" +
  "  <link rel=\"manifest\" href=\"/manifest.webmanifest\">\n" +
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
  "        <div class=\"site-nav__links\">\n" +
  "          <a class=\"site-nav__link\" href=\"/\">Shop</a>\n" +
  "          <a class=\"site-nav__link\" href=\"/collections\">Collections</a>\n" +
  "          <a class=\"site-nav__link\" href=\"/categories\">Categories</a>\n" +
  "          <a class=\"site-nav__link\" href=\"/blog\">Blog</a>\n" +
  "          <a class=\"site-nav__link\" href=\"/cart\">Cart</a>\n" +
  "        </div>\n" +
  "        <details class=\"site-nav__menu\">\n" +
  "          <summary class=\"site-nav__menu-toggle\" aria-label=\"Menu\"><svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" aria-hidden=\"true\"><path d=\"M4 7h16M4 12h16M4 17h16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\"/></svg><span class=\"site-nav__menu-label\">Menu</span></summary>\n" +
  "          <div class=\"site-nav__drawer\">\n" +
  "            <a class=\"site-nav__link\" href=\"/\">Shop</a>\n" +
  "            <a class=\"site-nav__link\" href=\"/collections\">Collections</a>\n" +
  "            <a class=\"site-nav__link\" href=\"/categories\">Categories</a>\n" +
  "            <a class=\"site-nav__link\" href=\"/blog\">Blog</a>\n" +
  "            <a class=\"site-nav__link\" href=\"/cart\">Cart</a>\n" +
  "          </div>\n" +
  "        </details>\n" +
  "      </nav>\n" +
  "    </div>\n" +
  "  </header>\n" +
  // See lib/storefront.js — always emitted, always empty, filled by the
  // session-chrome island so a cached body stays identical for every visitor.
  "  <div id=\"impersonation-banner\"></div>\n" +
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
  // The edge serves the storefront's DEFAULT locale (any explicit choice
  // bypasses the edge to the container), so `<html lang/dir>` carries the
  // configured default + its writing direction. The blog chrome strings
  // stay English literals — only the document language localizes.
  var locale = opts.locale || opts.defaultLocale || "en";
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
    lang:              locale,
    dir:               dirFor(locale),
    og_type:           opts.ogType || "website",
    og_title:          (opts.title || shopName) + " — " + shopName,
    og_description:    opts.description,
    og_image:          ogImage,
    canonical_url:     opts.canonicalUrl || "",
    year:              String(new Date().getUTCFullYear()),
  }).replace("RAW_CSS_INTEGRITY", stylesheetIntegrityAttr(themeCss))
    .replace("RAW_HREFLANG", alternateLinks({
      host:            opts.host,
      path:            opts.path,
      defaultLocale:   opts.defaultLocale || "en",
      supportedLocales: opts.supportedLocales,
      strategy:        opts.localeStrategy,
    }))
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

// Markdown body → sanitized HTML. Byte-for-byte port of the renderer in
// lib/blog-articles.js (#_renderMarkdown / #_renderInline) — the blog is
// edge-served, so the public post page is painted HERE; this mirror keeps
// the rendered HTML identical to what blogArticles.renderHtml produces so a
// post reads the same regardless of which substrate served it (and so the
// admin preview, which composes the lib primitive, matches the live page).
//
// XSS posture is the lib's: every operator-authored text run is HTML-escaped
// via b.template.escapeHtml; every link URL passes b.safeUrl.parse (https
// only) OR the `/`-rooted absolute-path allow-list; any URL that fails the
// gate is dropped and the anchor text falls back to inert escaped text. Raw
// HTML in the body is never passed through — any `<` lands as `&lt;`.
var CONTROL_BYTE_LINE_RE = new RegExp("[\\x00-\\x1f\\x7f]");
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

function _esc(s) {
  return b.template.escapeHtml(s);
}

function _safeLinkUrl(url) {
  if (typeof url !== "string" || !url.length || url.length > 2048) return null;
  if (CONTROL_BYTE_LINE_RE.test(url) || ZERO_WIDTH_RE.test(url)) return null;
  if (url.charCodeAt(0) === 47 /* "/" */) {
    if (url.length > 1 && url.charCodeAt(1) === 47) return null;
    if (url.indexOf("..") !== -1) return null;
    return url;
  }
  // https-only absolute URL. The parse throws on anything else (other
  // scheme, malformed) — treat a throw as "not a safe link". The result is
  // assigned and returned after the try so the catch body holds no
  // `return null` (which the edge-handler detector reserves for routing
  // dispatch); the rendered output is identical to lib/blog-articles.js.
  var safe = null;
  try {
    b.safeUrl.parse(url, { allowedProtocols: ["https:"] });
    safe = url;
  } catch (_e) {
    safe = null;
  }
  return safe;
}

function _renderInline(line) {
  var out = "";
  var i = 0;
  while (i < line.length) {
    var ch = line.charAt(i);
    if (ch === "`") {
      var end = line.indexOf("`", i + 1);
      if (end !== -1) {
        out += "<code>" + _esc(line.slice(i + 1, end)) + "</code>";
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      var closeBracket = line.indexOf("]", i + 1);
      if (closeBracket !== -1 && line.charAt(closeBracket + 1) === "(") {
        var closeParen = line.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          var text = line.slice(i + 1, closeBracket);
          var url  = line.slice(closeBracket + 2, closeParen);
          var safe = _safeLinkUrl(url);
          if (safe) {
            out += '<a href="' + _esc(safe) + '">' + _renderInline(text) + "</a>";
          } else {
            out += _renderInline(text);
          }
          i = closeParen + 1;
          continue;
        }
      }
    }
    if (ch === "*" && line.charAt(i + 1) === "*") {
      var endBold = line.indexOf("**", i + 2);
      if (endBold !== -1) {
        out += "<strong>" + _renderInline(line.slice(i + 2, endBold)) + "</strong>";
        i = endBold + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      var endItalic = line.indexOf(ch, i + 1);
      if (endItalic !== -1 && endItalic !== i + 1) {
        out += "<em>" + _renderInline(line.slice(i + 1, endItalic)) + "</em>";
        i = endItalic + 1;
        continue;
      }
    }
    out += _esc(ch);
    i += 1;
  }
  return out;
}

function _renderMarkdown(body) {
  var normalized = String(body).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  var lines = normalized.split("\n");
  var out = [];
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (line.trim() === "") { i += 1; continue; }
    if (/^-{3,}\s*$/.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }
    var hMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hMatch) {
      var level = hMatch[1].length;
      out.push("<h" + level + ">" + _renderInline(hMatch[2].trim()) + "</h" + level + ">");
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      var quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push("<blockquote><p>" + _renderInline(quoteLines.join(" ")) + "</p></blockquote>");
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      var ulItems = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        ulItems.push(lines[i].replace(/^[-*]\s+/, ""));
        i += 1;
      }
      var ulHtml = ulItems.map(function (item) {
        return "<li>" + _renderInline(item) + "</li>";
      }).join("");
      out.push("<ul>" + ulHtml + "</ul>");
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      var olItems = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        olItems.push(lines[i].replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      var olHtml = olItems.map(function (item) {
        return "<li>" + _renderInline(item) + "</li>";
      }).join("");
      out.push("<ol>" + olHtml + "</ol>");
      continue;
    }
    var paraLines = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^-{3,}\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    out.push("<p>" + _renderInline(paraLines.join(" ")) + "</p>");
  }
  return out.join("\n");
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
    locale:           opts.locale,
    defaultLocale:    opts.defaultLocale,
    host:             opts.host,
    path:             opts.path,
    supportedLocales: opts.supportedLocales,
    localeStrategy:   opts.localeStrategy,
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
  var bodyHtml = _renderMarkdown(article.body || "");
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
    locale:           opts.locale,
    defaultLocale:    opts.defaultLocale,
    host:             opts.host,
    path:             opts.path,
    supportedLocales: opts.supportedLocales,
    localeStrategy:   opts.localeStrategy,
  }, articleHtml + jsonLd);
}
