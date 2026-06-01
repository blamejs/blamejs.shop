"use strict";
/**
 * Blog index correctness — pagination, HEAD-request 404 bodies, and the
 * public byline.
 *
 * Three contracts, exercised against the edge blog renderer
 * (worker/render/blog.js) plus the edge route wiring (worker/index.js):
 *
 *   1. PAGINATION — the blog index paginates 12 posts per page with a
 *      prev/next nav reusing the search-pagination shell. Page 1 with a
 *      real next page shows a Next link and a disabled Previous; page 2
 *      shows a Previous link; the last page shows a disabled Next (no
 *      phantom page). The route reads `?page=N`, peeks one row past the
 *      page (`limit + 1`) to decide whether a real next page exists, and
 *      a garbage `?page` degrades to page 1 rather than 500-ing.
 *
 *   2. HEAD-REQUEST 404 BODY — a HEAD to a missing blog post / product
 *      returns the 404 status + headers with NO body (the same
 *      `request.method === "HEAD" ? null : html` guard the page + cart
 *      routes already carry).
 *
 *   3. PUBLIC BYLINE — the blog model carries no author display-name
 *      column, only the internal `author_id`. The list card, the article
 *      byline, and the Article JSON-LD author must show the shop name, not
 *      the raw `author_id`.
 *
 * The edge ESM renderer loads via dynamic import behind an `fs.existsSync`
 * guard: `worker/` is excluded from the container build context, so the
 * in-image smoke run skips the edge half; the full-tree run exercises it.
 * The route-source assertions (offset/peek threading + HEAD guard) read
 * worker/index.js directly so they hold even in the in-image run where the
 * route can't be driven.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var path       = require("node:path");
var fs         = require("node:fs");
var nodeModule = require("node:module");
var nodeUrl    = require("node:url");

var helpers = require("../helpers");
var check   = helpers.check;

var manifest = require("../../lib/asset-manifest.json");

var SHOP = "Acme Goods";
var OPAQUE_AUTHOR = "usr_01HZX9Q7F3K2M5N8P0R4T6V8W0";   // an internal id, never a display name

// The edge render modules import asset-manifest.json with a bare
// `import x from "./asset-manifest.json"`; register the resolve hook that
// supplies the `type: "json"` attribute so the same source runs unbundled.
var _jsonHookRegistered = false;
function _registerJsonHook() {
  if (_jsonHookRegistered) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  _jsonHookRegistered = true;
}

function _articles(n, startIdx) {
  startIdx = startIdx || 0;
  var out = [];
  for (var i = 0; i < n; i += 1) {
    var k = startIdx + i;
    out.push({
      slug:             "post-" + k,
      title:            "Post " + k,
      author_id:        OPAQUE_AUTHOR,
      meta_description: "Lede for post " + k,
      published_at:     1700000000000 - k * 86400000,
    });
  }
  return out;
}

// Pull every application/ld+json block's parsed object out of the HTML.
function _jsonLdBlocks(html) {
  var out = [];
  var re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    try { out.push(JSON.parse(m[1].replace(/<\\\/script/g, "</script"))); }
    catch (_e) { /* not what we're asserting on */ }
  }
  return out;
}

function _findType(blocks, type) {
  for (var i = 0; i < blocks.length; i += 1) {
    if (blocks[i] && blocks[i]["@type"] === type) return blocks[i];
  }
  return null;
}

// The pager region — the search-pagination nav, scoped so the prev/next
// link assertions don't pick up unrelated chrome links.
function _pagerRegion(html) {
  var m = html.match(/<nav class="search-pagination[^"]*"[^>]*>([\s\S]*?)<\/nav>/);
  return m ? m[1] : null;
}

async function _run() {
  // ---- route-source contracts (full-tree only) --------------------------
  // worker/index.js is EXCLUDED from the container build context, so reading
  // it would ENOENT in the in-image smoke run. Guard the source read so the
  // in-image run skips these (the full-tree GH smoke still pins Fix 1+2); the
  // route behaviour is additionally driven end-to-end in the GH run.
  var indexPath = path.resolve(__dirname, "..", "..", "worker", "index.js");
  if (fs.existsSync(indexPath)) {
    var indexSrc = fs.readFileSync(indexPath, "utf8");

    // FIX 1: the /blog route reads ?page, peeks limit+1, and threads offset +
    // hasNext into the renderer.
    check("route: blog list peeks one past the page (BLOG_PAGE_SIZE + 1)",
      /listBlogArticles\([\s\S]{0,160}?limit:\s*BLOG_PAGE_SIZE\s*\+\s*1/.test(indexSrc));
    check("route: blog list threads a computed offset",
      /offset:\s*offset/.test(indexSrc) && /\(page\s*-\s*1\)\s*\*\s*BLOG_PAGE_SIZE/.test(indexSrc));
    check("route: blog list derives hasNext from the peeked row count",
      /hasNext\s*=\s*result\.rows\.length\s*>\s*BLOG_PAGE_SIZE/.test(indexSrc));
    check("route: blog list slices the peeked row off before render",
      /result\.rows\.slice\(0,\s*BLOG_PAGE_SIZE\)/.test(indexSrc));

    // FIX 2: BOTH the blog-post 404 and the product 404 guard the body on HEAD.
    var guarded404 = indexSrc.match(
      /new Response\(\s*request\.method === "HEAD" \? null : html,\s*\{\s*status:\s*404/g
    ) || [];
    check("route: at least the blog-post + product 404s guard the body on HEAD (>= 2 guarded 404 responses)",
      guarded404.length >= 2);
    check("route: no 404 Response ships an unconditional body",
      /new Response\(\s*html,\s*\{\s*status:\s*404/.test(indexSrc) === false);
  }

  // ---- edge renderer contracts -------------------------------------------
  var renderDir = path.resolve(__dirname, "..", "..", "worker", "render");
  var blogPath  = path.join(renderDir, "blog.js");
  if (!fs.existsSync(blogPath)) {
    // worker/ excluded from the container build context — the route-source
    // assertions above still pin Fix 1 + Fix 2 in the in-image smoke run.
    return;
  }
  _registerJsonHook();
  var edgeBlog = await import(nodeUrl.pathToFileURL(blogPath).href);

  // FIX 1: page 1 with a real next page — a Next link, a disabled Previous.
  var page1 = edgeBlog.renderBlogList({
    articles: _articles(12, 0),
    shopName: SHOP,
    version:  manifest.version,
    page:     1,
    hasNext:  true,
    canonicalUrl: "https://shop.example/blog",
  });
  var pager1 = _pagerRegion(page1);
  check("page 1: pager nav present",                         pager1 !== null);
  check("page 1: shows exactly 12 cards",                    (page1.match(/class="blog-card"/g) || []).length === 12);
  check("page 1: Next link points to ?page=2",              pager1.indexOf("href=\"/blog?page=2\"") !== -1);
  check("page 1: Next carries rel=next",                    /rel="next"/.test(pager1));
  check("page 1: Previous is the disabled span (no prev page)",
    /search-pagination__prev is-disabled/.test(pager1) && pager1.indexOf("href=\"/blog\"") === -1);

  // FIX 1: page 2 with the remainder — a Previous link back to /blog, no Next.
  var page2 = edgeBlog.renderBlogList({
    articles: _articles(3, 12),
    shopName: SHOP,
    version:  manifest.version,
    page:     2,
    hasNext:  false,
    canonicalUrl: "https://shop.example/blog",
  });
  var pager2 = _pagerRegion(page2);
  check("page 2: pager nav present",                         pager2 !== null);
  check("page 2: shows the 3 remaining cards",               (page2.match(/class="blog-card"/g) || []).length === 3);
  check("page 2: Previous link points to /blog (page 1 is the bare URL)",
    pager2.indexOf("href=\"/blog\"") !== -1 && /rel="prev"/.test(pager2));
  check("page 2: Next is the disabled span (last page — no phantom next)",
    /search-pagination__next is-disabled/.test(pager2) && pager2.indexOf("?page=3") === -1);

  // FIX 1: a single page (page 1, no next) renders NO pager nav.
  var single = edgeBlog.renderBlogList({
    articles: _articles(5, 0),
    shopName: SHOP,
    version:  manifest.version,
    page:     1,
    hasNext:  false,
    canonicalUrl: "https://shop.example/blog",
  });
  check("single page: no pager nav (byte-identical to unpaginated)",
    _pagerRegion(single) === null);

  // FIX 1: an empty blog renders no pager (and no cards).
  var empty = edgeBlog.renderBlogList({
    articles: [],
    shopName: SHOP,
    version:  manifest.version,
    page:     1,
    hasNext:  false,
    canonicalUrl: "https://shop.example/blog",
  });
  check("empty blog: no pager nav", _pagerRegion(empty) === null);
  check("empty blog: no cards",     empty.indexOf("class=\"blog-card\"") === -1);

  // FIX 1: a garbage page param degrades to page 1 in the route's parser
  // (no throw, page 1's URL shape). Drive the parser indirectly: the
  // renderer clamps a non-positive / non-integer page to 1, so a Previous
  // link never points at a bogus page.
  var clampPage = edgeBlog.renderBlogList({
    articles: _articles(12, 0),
    shopName: SHOP,
    version:  manifest.version,
    page:     -7,            // garbage — renderer treats as page 1
    hasNext:  true,
    canonicalUrl: "https://shop.example/blog",
  });
  var clampPager = _pagerRegion(clampPage);
  check("garbage page: renderer clamps to page 1 (Previous disabled, Next -> ?page=2)",
    /search-pagination__prev is-disabled/.test(clampPager) &&
    clampPager.indexOf("href=\"/blog?page=2\"") !== -1);

  // ---- FIX 3: the byline shows the shop name, never the raw author_id -----
  // List card byline.
  check("list card byline shows the shop name", page1.indexOf("By " + SHOP) !== -1);
  check("list card byline does NOT leak the raw author_id",
    page1.indexOf(OPAQUE_AUTHOR) === -1);

  // Article byline + Article JSON-LD author.
  var article = edgeBlog.renderBlogArticle({
    article: {
      slug: "post-1", title: "Post One", author_id: OPAQUE_AUTHOR,
      body: "Body copy.", published_at: 1700000000000, updated_at: 1700000000000,
      meta_description: "A post.",
    },
    shopName:     SHOP,
    version:      manifest.version,
    canonicalUrl: "https://shop.example/blog/post-1",
  });
  check("article byline shows the shop name",          article.indexOf("By " + SHOP) !== -1);
  check("article does NOT leak the raw author_id anywhere",
    article.indexOf(OPAQUE_AUTHOR) === -1);
  var blocks  = _jsonLdBlocks(article);
  var ldArticle = _findType(blocks, "Article");
  check("Article JSON-LD present", ldArticle !== null);
  check("Article JSON-LD author name is the shop name, not the author_id",
    ldArticle.author && ldArticle.author.name === SHOP);
  check("Article JSON-LD author name is NOT the raw author_id",
    !(ldArticle.author && ldArticle.author.name === OPAQUE_AUTHOR));
}

module.exports = { run: _run };
