"use strict";
/**
 * Edge content-page localization (COMPAT-1).
 *
 * The edge `blog.js` / `pages.js` / `policy.js` LAYOUTs previously
 * hardcoded `<html lang="en">`. They now localize the default-locale
 * `<html lang>` / `dir` the same way the container does — the edge serves
 * the storefront's DEFAULT locale, so the document language reflects the
 * configured default + its writing direction (`dirFor`), while the page
 * chrome strings stay English literals (only `<html>` localizes).
 *
 * Pure render functions — no DB, no HTTP. The edge ESM modules load via
 * dynamic import behind an `fs.existsSync` guard preceding each specific
 * import: `worker/` is excluded from the container build context, so the
 * in-image smoke skips the edge half (the container half still pins the
 * baseline). Mirrors storefront-render-dollar-and-robots.test.js.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var path       = require("node:path");
var fs         = require("node:fs");
var nodeModule = require("node:module");
var nodeUrl    = require("node:url");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

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

// The `<html …>` open tag of a document.
function _htmlOpenTag(html) {
  var m = html.match(/<html[^>]*>/);
  return m ? m[0] : null;
}

async function _run() {
  // ---- container baseline: default locale is en / ltr -------------------
  // The container renders content pages through the storefront mount (not a
  // pure fn); its `_wrap` fills lang/dir from the resolved locale context
  // (English baseline absent a wired policy). renderHome goes through the
  // same `_wrap`, so it pins the container baseline `<html …>` open tag the
  // edge default-locale render must match.
  var cHome = bShop.storefront.renderHome({
    products: [], shop_name: "Acme", cart_count: 0,
  });
  check("container home <html lang=en dir=ltr>",
    cHome.indexOf("<html lang=\"en\" dir=\"ltr\">") !== -1);
  check("container home carries manifest link",
    cHome.indexOf("<link rel=\"manifest\" href=\"/manifest.webmanifest\">") !== -1);

  // ---- edge half (worker/) — guarded by fs.existsSync -------------------
  var renderDir = path.resolve(__dirname, "..", "..", "worker", "render");
  var blogPath   = path.join(renderDir, "blog.js");
  var pagesPath  = path.join(renderDir, "pages.js");
  var policyPath = path.join(renderDir, "policy.js");
  if (!fs.existsSync(blogPath) || !fs.existsSync(pagesPath) || !fs.existsSync(policyPath)) {
    // worker/ excluded from the container build context — the container
    // assertions above still run in the in-image smoke.
    return;
  }
  _registerJsonHook();
  var edgeBlog   = await import(nodeUrl.pathToFileURL(blogPath).href);
  var edgePages  = await import(nodeUrl.pathToFileURL(pagesPath).href);
  var edgePolicy = await import(nodeUrl.pathToFileURL(policyPath).href);

  // A CMS page rendered at the edge with an RTL default locale → lang+dir.
  var arPage = edgePages.renderStorefrontPage({
    page:     { slug: "about", title: "About", body: "Hello.", layout: "default", status: "published", updated_at: 0 },
    shopName: "Acme",
    defaultLocale: "ar",
  });
  check("edge page no hardcoded lang=en",  _htmlOpenTag(arPage).indexOf("lang=\"en\"") === -1);
  check("edge page ar → lang=ar dir=rtl",  arPage.indexOf("<html lang=\"ar\" dir=\"rtl\">") !== -1);

  var dePage = edgePages.renderStorefrontPage({
    page:     { slug: "about", title: "About", body: "Hallo.", layout: "default", status: "published", updated_at: 0 },
    shopName: "Acme",
    defaultLocale: "de",
  });
  check("edge page de → lang=de dir=ltr",  dePage.indexOf("<html lang=\"de\" dir=\"ltr\">") !== -1);

  // A blog article rendered at the edge.
  var arArticle = edgeBlog.renderBlogArticle({
    article:  { slug: "p1", title: "Post", body: "Body.", published_at: 0, updated_at: 0 },
    shopName: "Acme",
    defaultLocale: "ar",
  });
  check("edge blog article no hardcoded lang=en", _htmlOpenTag(arArticle).indexOf("lang=\"en\"") === -1);
  check("edge blog article ar → lang=ar dir=rtl", arArticle.indexOf("<html lang=\"ar\" dir=\"rtl\">") !== -1);

  var deList = edgeBlog.renderBlogList({
    articles: [], shopName: "Acme", defaultLocale: "de",
  });
  check("edge blog list de → lang=de dir=ltr",  deList.indexOf("<html lang=\"de\" dir=\"ltr\">") !== -1);

  // A policy page (privacy) rendered at the edge.
  var arPrivacy = edgePolicy.renderPrivacy({ shopName: "Acme", defaultLocale: "ar" });
  check("edge policy no hardcoded lang=en", _htmlOpenTag(arPrivacy).indexOf("lang=\"en\"") === -1);
  check("edge policy ar → lang=ar dir=rtl", arPrivacy.indexOf("<html lang=\"ar\" dir=\"rtl\">") !== -1);

  var dePrivacy = edgePolicy.renderPrivacy({ shopName: "Acme", defaultLocale: "de" });
  check("edge policy de → lang=de dir=ltr",  dePrivacy.indexOf("<html lang=\"de\" dir=\"ltr\">") !== -1);

  // ---- parity: edge default-locale <html …> matches the container ------
  // With the default locale (en/ltr), every edge content page emits the
  // same `<html …>` open tag the container baseline emits.
  var enPage = edgePages.renderStorefrontPage({
    page:     { slug: "about", title: "About", body: "Hi.", layout: "default", status: "published", updated_at: 0 },
    shopName: "Acme",
    defaultLocale: "en",
  });
  check("edge page default-locale <html> == container",
    _htmlOpenTag(enPage) === _htmlOpenTag(cHome));

  // The manifest link is present in every edge content LAYOUT.
  check("edge page carries manifest link",
    enPage.indexOf("<link rel=\"manifest\" href=\"/manifest.webmanifest\">") !== -1);
  check("edge blog carries manifest link",
    deList.indexOf("<link rel=\"manifest\" href=\"/manifest.webmanifest\">") !== -1);
  check("edge policy carries manifest link",
    dePrivacy.indexOf("<link rel=\"manifest\" href=\"/manifest.webmanifest\">") !== -1);
}

module.exports = { run: _run };
