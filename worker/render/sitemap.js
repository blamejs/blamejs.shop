// sitemap.xml renderer. Composes the URL set from the static-page
// roster (home + policy pages) plus every active product slug, active
// collection + category slug, published CMS-page slug, and published
// blog article slug from D1. Output matches sitemaps.org/schemas/
// sitemap/0.9 — XML escape composes b.template.escapeHtml through the
// strict renderTemplate. Mirrors the container's /sitemap.xml coverage
// (the collection / category / page `<loc>` values match for the same
// origin + slug).
import { renderTemplate } from "./_lib.js";

var URLSET_TPL =
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
  "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n" +
  "RAW_ENTRIES_PLACEHOLDER" +
  "</urlset>\n";

var ENTRY_TPL =
  "  <url>\n" +
  "    <loc>{{loc}}</loc>\n" +
  "    <lastmod>{{lastmod}}</lastmod>\n" +
  "    <changefreq>{{changefreq}}</changefreq>\n" +
  "    <priority>{{priority}}</priority>\n" +
  "  </url>\n";

function _isoDate(epochMs) {
  if (!Number.isInteger(epochMs)) return new Date().toISOString().slice(0, 10);
  return new Date(epochMs).toISOString().slice(0, 10);
}

function _entry(loc, lastmod, changefreq, priority) {
  return renderTemplate(ENTRY_TPL, {
    loc:        loc,
    lastmod:    lastmod,
    changefreq: changefreq,
    priority:   priority,
  });
}

export function renderSitemap(opts) {
  opts = opts || {};
  var origin      = opts.origin   || "https://blamejs.shop";
  var products    = Array.isArray(opts.products) ? opts.products : [];
  var collections = Array.isArray(opts.collections) ? opts.collections : [];
  var categories  = Array.isArray(opts.categories) ? opts.categories : [];
  var pages       = Array.isArray(opts.pages) ? opts.pages : [];
  var blogPosts   = Array.isArray(opts.blogPosts) ? opts.blogPosts : [];
  var nowIso = new Date().toISOString().slice(0, 10);

  var entries = "";

  // Static-page roster — home + policy pages. Priorities mirror
  // operator-facing surface importance: home is the entry point,
  // privacy / terms are leaf legal docs.
  entries += _entry(origin + "/",          nowIso, "daily",   "1.0");
  entries += _entry(origin + "/privacy",   nowIso, "monthly", "0.3");
  entries += _entry(origin + "/terms",     nowIso, "monthly", "0.3");

  // Active products. `daily` changefreq because price + inventory
  // can move between checks; priority 0.8 ranks below the home page
  // but above legal pages. Slugs URL-encode at the path segment so a
  // hypothetical slug with spaces / `&` / etc. produces a valid URL
  // (the database column has no shape constraint; defense in depth).
  for (var i = 0; i < products.length; i += 1) {
    var p = products[i];
    entries += _entry(
      origin + "/products/" + encodeURIComponent(p.slug),
      _isoDate(p.updated_at),
      "daily",
      "0.8"
    );
  }

  // Active collection + category browse pages. `weekly` / 0.6 matches
  // the container's sitemap so the two substrates emit the same
  // `<loc>` for the same origin + slug.
  for (var ci = 0; ci < collections.length; ci += 1) {
    var col = collections[ci];
    entries += _entry(
      origin + "/collections/" + encodeURIComponent(col.slug),
      _isoDate(col.updated_at),
      "weekly",
      "0.6"
    );
  }
  for (var ki = 0; ki < categories.length; ki += 1) {
    var cat = categories[ki];
    entries += _entry(
      origin + "/categories/" + encodeURIComponent(cat.slug),
      _isoDate(cat.updated_at),
      "weekly",
      "0.6"
    );
  }

  // Published CMS pages (/pages/<slug>). `monthly` / 0.5 — operator
  // content changes less often than the catalog. Same values the
  // container emits for parity.
  for (var pi = 0; pi < pages.length; pi += 1) {
    var pg = pages[pi];
    entries += _entry(
      origin + "/pages/" + encodeURIComponent(pg.slug),
      _isoDate(pg.updated_at),
      "monthly",
      "0.5"
    );
  }

  // Published blog articles. `weekly` matches editorial cadence;
  // priority 0.6 places below products but above legal.
  for (var j = 0; j < blogPosts.length; j += 1) {
    var post = blogPosts[j];
    entries += _entry(
      origin + "/blog/" + encodeURIComponent(post.slug),
      _isoDate(post.updated_at),
      "weekly",
      "0.6"
    );
  }

  return URLSET_TPL.replace("RAW_ENTRIES_PLACEHOLDER", entries);
}
