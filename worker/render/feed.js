// RSS 2.0 feed for the storefront blog. The XML is composed through
// the same strict-validating template engine the rest of the Worker
// uses (`renderTemplate` from `./_lib.js`, which routes per-value
// substitution through `b.template.escapeHtml`). XML 1.0 §4.6 accepts
// the numeric `&#x27;` reference `b.template.escapeHtml` emits, so
// the HTML primitive covers XML output too.
import { renderTemplate, spliceRaw } from "./_lib.js";

var CHANNEL_TPL =
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
  "<rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\">\n" +
  "<channel>\n" +
  "  <title>{{title}}</title>\n" +
  "  <link>{{origin}}/</link>\n" +
  "  <atom:link href=\"{{self_url}}\" rel=\"self\" type=\"application/rss+xml\"/>\n" +
  "  <description>{{description}}</description>\n" +
  "  <language>en-us</language>\n" +
  "  <lastBuildDate>{{last_build}}</lastBuildDate>\n" +
  "RAW_ITEMS_PLACEHOLDER" +
  "</channel>\n</rss>\n";

var ITEM_TPL =
  "  <item>\n" +
  "    <title>{{title}}</title>\n" +
  "    <link>{{url}}</link>\n" +
  "    <guid isPermaLink=\"true\">{{url_guid}}</guid>\n" +
  "    <pubDate>{{pub_date}}</pubDate>\n" +
  "    <description>{{description}}</description>\n" +
  "    <author>{{author}}</author>\n" +
  "  </item>\n";

function _rfc822(epochMs) {
  if (!Number.isInteger(epochMs)) return "";
  return new Date(epochMs).toUTCString();
}

function _renderItem(article, origin, shopName) {
  var url = origin + "/blog/" + article.slug;
  var description = article.meta_description != null && article.meta_description.length > 0
    ? article.meta_description
    : String(article.body || "").slice(0, 280);
  return renderTemplate(ITEM_TPL, {
    title:       article.title,
    url:         url,
    url_guid:    url,
    pub_date:    _rfc822(article.published_at),
    description: description,
    // The byline is the shop name, never the internal `author_id` (an
    // operator/user id that the blog page renderers deliberately suppress).
    // The blog model carries no author display-name column, so the shop
    // name is the cleanest non-leaking source — matching what the on-page
    // byline and the Article JSON-LD already emit.
    author:      shopName,
  });
}

export function renderFeed(opts) {
  opts = opts || {};
  var shopName = opts.shopName || "blamejs.shop";
  var origin   = opts.origin   || "https://blamejs.shop";
  var articles = Array.isArray(opts.articles) ? opts.articles : [];
  var lastBuild = articles.length
    ? _rfc822(articles[0].published_at || articles[0].updated_at)
    : new Date().toUTCString();
  var items = articles.map(function (a) { return _renderItem(a, origin, shopName); }).join("");
  // Splice the rendered items LITERALLY. `String.replace(token, string)`
  // gives the replacement string's `$` sequences special meaning (`$&`,
  // `` $` ``, `$'`, `$1`), so a post title / body carrying a `$`-sequence
  // would corrupt — and `` $` `` would splice the channel head into the
  // item. The item XML is already escaped at its own render site; this is
  // purely about the replace mechanics. `spliceRaw` uses a replacer
  // function so the fragment is inserted verbatim with no `$`
  // interpretation. Mirrors how the page/blog renderers splice raw bodies.
  return spliceRaw(renderTemplate(CHANNEL_TPL, {
    title:       shopName + " — Blog",
    origin:      origin,
    self_url:    origin + "/feed.xml",
    description: "Editorial blog from " + shopName + ".",
    last_build:  lastBuild,
  }), "RAW_ITEMS_PLACEHOLDER", items);
}
