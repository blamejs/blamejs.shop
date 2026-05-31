"use strict";
/**
 * Storefront render hardening — dollar-injection-safe body splicing +
 * search-result noindex.
 *
 * Two render contracts, exercised against BOTH render substrates (the
 * container `lib/storefront.js` and the edge `worker/render/*`):
 *
 *   1. DOLLAR-SAFE BODY SPLICE — a page body (a blog post, a CMS page, a
 *      reflected search query) is spliced into the assembled HTML at a
 *      `RAW_BODY*` placeholder. A body containing a `$` sequence
 *      (`` $` `` = the text before the match, `$&`, `$1`, `$$`) must NOT
 *      trigger `String.prototype.replace`'s replacement-string dollar
 *      substitution — otherwise a body with a dollar-backtick splices the
 *      whole page <head> into the body. We render a blog post + a CMS page
 *      whose body carries `` $` `` and `$&`, then assert the document has
 *      exactly one <head>/<!DOCTYPE> (no head duplicated into the body) and
 *      the literal dollar characters survive in the rendered body.
 *
 *   2. SEARCH RESULT noindex — internal search result pages are thin /
 *      duplicate indexable URLs (one per query + facet combination). Both
 *      render paths must stamp `<meta name="robots" content="noindex,
 *      follow">` (follow, so the product links the page lists are still
 *      crawled) while an indexable product page carries no robots meta.
 *
 * Pure render functions — no DB, no HTTP. The edge ESM modules are loaded
 * via dynamic import behind an `fs.existsSync` guard: `worker/` is excluded
 * from the container build context, so the in-image smoke run skips the
 * edge half (the container half still pins the contract); the full-tree CI
 * run exercises both.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var path       = require("node:path");
var fs         = require("node:fs");
var nodeModule = require("node:module");
var nodeUrl    = require("node:url");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var manifest = require("../../lib/asset-manifest.json");

// The edge render modules import asset-manifest.json with a bare
// `import x from "./asset-manifest.json"` the bundler annotates with the
// `type: "json"` attribute at build time. Register a one-shot resolve hook
// that supplies it so the same source runs unbundled here. Mirrors
// search-faceting-parity.test.js.
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

// Pull the `<main …>…</main>` region out of a full HTML document so the
// body assertions are scoped to the page body, not the chrome.
function _mainRegion(html) {
  var m = html.match(/<main[^>]*>([\s\S]*?)<\/main>/);
  return m ? m[1] : null;
}

function _count(html, needle) {
  var n = 0, i = 0;
  while ((i = html.indexOf(needle, i)) !== -1) { n += 1; i += needle.length; }
  return n;
}

// A body crafted to weaponise every `String.replace` replacement-string
// dollar token. `` $` `` is the dangerous one — it expands to the entire
// text BEFORE the match (the whole page <head> + chrome) when the body is
// passed as the replacement string. `$&` re-emits the placeholder; `$1`
// has no capture group; `$$` collapses to a single `$`. With the
// function-replacer fix, every one of these survives as a literal.
// Markers avoid Markdown-active characters (no `_` / `*`) so they survive
// the CMS Markdown renderer verbatim; the dollar tokens are the payload.
var DOLLAR_BODY = "ZZPRE $` head-leak probe and $& and $1 and $$ ZZPOST";

function _assertDollarSafe(label, html) {
  var main = _mainRegion(html);
  check(label + ": <main> present", main !== null);
  // The whole document must have exactly one DOCTYPE and one <head> open —
  // a dollar-backtick head-leak duplicates the head into the body.
  check(label + ": single <!DOCTYPE> (no head leaked into body)", _count(html, "<!DOCTYPE") === 1);
  check(label + ": no <title> leaked into <main>",                 main.indexOf("<title>") === -1);
  // `<head>` (the document head open tag) — distinct from `<header>`, which
  // legitimately appears inside <main>; a dollar-backtick leak would inject
  // the literal head open tag into the body.
  check(label + ": no leaked <head> into <main>",                  main.indexOf("<head>") === -1);
  // The literal dollar sequences survive verbatim in the body (escapeHtml
  // does not touch `$` or the backtick).
  check(label + ": literal dollar-backtick survives in body",      main.indexOf("$`") !== -1);
  check(label + ": literal $& survives in body",                   main.indexOf("$&") !== -1);
  check(label + ": body markers both present",                     main.indexOf("ZZPRE") !== -1 && main.indexOf("ZZPOST") !== -1);
}

async function _run() {
  // ---- FIX 1: container — reflected search query with a $ sequence ------
  // A no-match query is echoed into the result-page body summary. The query
  // carries a dollar-backtick; the body splice must not leak the head.
  var cSearchDollar = bShop.storefront.renderSearch({
    q:          "ZZPRE $` $& q ZZPOST",
    products:   [],
    facets:     [],
    filters:    {},
    total:      0,
    shop_name:  "Acme",
    cart_count: 0,
  });
  _assertDollarSafe("container search ($-query)", cSearchDollar);

  // ---- FIX 2: container — search carries noindex,follow; product none ---
  var cSearch = bShop.storefront.renderSearch({
    q: "tee", products: [], facets: [], filters: {}, total: 0, shop_name: "Acme", cart_count: 0,
  });
  check("container search has robots noindex,follow",
    cSearch.indexOf("<meta name=\"robots\" content=\"noindex,follow\">") !== -1);
  check("container search is NOT noindex,nofollow",
    cSearch.indexOf("noindex,nofollow") === -1);

  var cProduct = bShop.storefront.renderProduct({
    product:  { slug: "widget-pro", title: "Widget Pro", description: "desc" },
    variants: [{ id: "v1", sku: "WDG-1", title: "Default", options: {} }],
    prices:   { v1: { amount_minor: 2999, currency: "USD" } },
    shop_name: "Acme",
  });
  check("container product page carries NO robots meta", /name="robots"/.test(cProduct) === false);

  // ---- edge half (worker/) — guarded by fs.existsSync --------------------
  var renderDir = path.resolve(__dirname, "..", "..", "worker", "render");
  var pagesPath  = path.join(renderDir, "pages.js");
  var blogPath   = path.join(renderDir, "blog.js");
  var searchPath = path.join(renderDir, "search.js");
  var productPath = path.join(renderDir, "product.js");
  if (!fs.existsSync(pagesPath) || !fs.existsSync(blogPath) ||
      !fs.existsSync(searchPath) || !fs.existsSync(productPath)) {
    // worker/ excluded from the container build context — the container
    // assertions above still pin the contract in the in-image smoke run.
    return;
  }
  _registerJsonHook();
  var edgePages   = await import(nodeUrl.pathToFileURL(pagesPath).href);
  var edgeBlog    = await import(nodeUrl.pathToFileURL(blogPath).href);
  var edgeSearch  = await import(nodeUrl.pathToFileURL(searchPath).href);
  var edgeProduct = await import(nodeUrl.pathToFileURL(productPath).href);

  // FIX 1: edge CMS page body with a $ sequence.
  var edgePage = edgePages.renderStorefrontPage({
    page:     { slug: "about", title: "About", body: DOLLAR_BODY, layout: "default", status: "published", updated_at: 0 },
    shopName: "Acme",
    version:  manifest.version,
  });
  _assertDollarSafe("edge CMS page ($-body)", edgePage);

  // FIX 1: edge blog article body with a $ sequence.
  var edgeArticle = edgeBlog.renderBlogArticle({
    article: { slug: "post-1", title: "Post One", author_id: "editor", body: DOLLAR_BODY, published_at: 0, updated_at: 0 },
    shopName: "Acme",
    version:  manifest.version,
  });
  _assertDollarSafe("edge blog article ($-body)", edgeArticle);

  // FIX 1: edge search reflected query with a $ sequence.
  var edgeSearchDollar = edgeSearch.renderSearch({
    q:        "ZZPRE $` $& q ZZPOST",
    products: [], facets: [], filters: {},
    total:    0, shopName: "Acme", cartCount: 0, version: manifest.version,
  });
  _assertDollarSafe("edge search ($-query)", edgeSearchDollar);

  // FIX 2: edge search carries noindex,follow; edge product none.
  var edgeSearchClean = edgeSearch.renderSearch({
    q: "tee", products: [], facets: [], filters: {}, total: 0, shopName: "Acme", cartCount: 0, version: manifest.version,
  });
  check("edge search has robots noindex,follow",
    edgeSearchClean.indexOf("<meta name=\"robots\" content=\"noindex,follow\">") !== -1);
  check("edge search is NOT noindex,nofollow",
    edgeSearchClean.indexOf("noindex,nofollow") === -1);

  var edgeProductHtml = edgeProduct.renderProduct({
    product:  { slug: "widget-pro", title: "Widget Pro", description: "desc" },
    variants: [{ id: "v1", sku: "WDG-1", title: "Default", options: {} }],
    prices:   { v1: { amount_minor: 2999, currency: "USD" } },
    shopName: "Acme",
    version:  manifest.version,
  });
  check("edge product page carries NO robots meta", /name="robots"/.test(edgeProductHtml) === false);

  // ---- dual-render parity: the search robots meta matches across paths --
  // Both substrates stamp the identical robots meta in the <head>, so the
  // edge-cached and container-served search pages stay consistent.
  check("search robots meta is byte-identical across substrates",
    (cSearch.indexOf("<meta name=\"robots\" content=\"noindex,follow\">") !== -1) ===
    (edgeSearchClean.indexOf("<meta name=\"robots\" content=\"noindex,follow\">") !== -1));
}

module.exports = { run: _run };
