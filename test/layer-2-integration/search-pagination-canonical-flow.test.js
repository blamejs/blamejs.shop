"use strict";
/**
 * Search pagination + result-count honesty, and indexable-page canonical
 * URLs — full HTTP integration of the storefront.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * searchFacets factory + searchSynonyms instance + collections, against
 * one in-memory `node:sqlite` DB loaded from the live migrations. Seeds
 * enough matching products to span more than one search page, plus a
 * facet, then asserts:
 *
 *   1. The "Showing N matches" copy reports the REAL total (every match),
 *      not the length of the first page slice.
 *   2. A second page is reachable (`?page=2`) and shows DIFFERENT products
 *      than page 1 — products past the first 24 are no longer unreachable.
 *   3. The page links carry the active query + facet state, so paging
 *      preserves the filter.
 *   4. The collections browse pages (index + a single collection) emit a
 *      correct ABSOLUTE canonical + og:url derived from the request host
 *      (the SEO/duplicate-content defect), and the cart/account pages —
 *      intentionally kept out of the index — carry a noindex robots meta.
 *
 * Network: zero — every request lands on 127.0.0.1.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var b = bShop.framework;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0043_collections.sql",
  "0055_search_synonyms.sql",
  "0082_search_facets.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-pgn-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

// Pull the canonical href + og:url out of a rendered <head>.
function _canonical(html) {
  var m = html.match(/<link rel="canonical" href="([^"]*)">/);
  return m ? m[1] : null;
}
function _ogUrl(html) {
  var m = html.match(/<meta property="og:url" content="([^"]*)">/);
  return m ? m[1] : null;
}
// Count product-card anchors in a results grid.
function _slugsOf(html) {
  var slugs = [];
  // Search result cards carry a `?from=search&sq=<q>` attribution suffix
  // (the click marker the PDP reads to log a ranking click event), so the
  // slug is followed by either the closing quote or the `?`-prefixed query
  // string.
  var re = /href="\/products\/([a-z0-9-]+)(?:\?[^"]*)?"/g;
  var m;
  while ((m = re.exec(html)) !== null) slugs.push(m[1]);
  return slugs;
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var collections = bShop.collections.create({ query: query, catalog: catalog, cursorSecret: "pgn-flow-cursor" });
  var searchSynonyms = bShop.searchSynonyms.create({ query: query });
  var searchFacets = function (perRequestCatalog) {
    return bShop.searchFacets.create({ query: query, catalog: perRequestCatalog });
  };

  // ---- seed catalog ----
  // 30 "widget" products so a query for "widget" matches MORE than one
  // page (page size is 24). The first 27 are in stock, the last 3 out of
  // stock, so an availability=true filter still spans >24 to keep the
  // paginated-with-facet case meaningful. All in the "gadgets" collection.
  async function _seedProduct(slug, title, desc, priceMinor, stock, collectionSlugs) {
    var p = await catalog.products.create({ slug: slug, title: title, description: desc, status: "active" });
    var v = await catalog.variants.create(p.id, { sku: slug.toUpperCase() + "-1", options: { size: "M" } });
    await catalog.prices.set(v.id, { currency: "USD", amount_minor: priceMinor });
    await catalog.inventory.create(v.sku, { stock_on_hand: stock });
    var now = Date.now();
    for (var i = 0; i < collectionSlugs.length; i += 1) {
      await query(
        "INSERT INTO collection_members (id, collection_slug, product_id, position, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        [b.uuid.v7(), collectionSlugs[i], p.id, i, now],
      );
    }
    return p;
  }

  var now = Date.now();
  await query(
    "INSERT INTO collections (slug, type, title, description, sort_strategy, created_at, updated_at) " +
    "VALUES ('gadgets', 'manual', 'Gadgets', 'Every widget we stock.', 'manual', ?1, ?1)",
    [now],
  );

  var TOTAL = 30;
  for (var i = 0; i < TOTAL; i += 1) {
    var n = i + 1;
    var pad = n < 10 ? "0" + n : String(n);
    var inStock = i < 27 ? 5 : 0;
    await _seedProduct("widget-" + pad, "Widget " + pad, "A handy widget number " + pad + ".", 1000 + n, inStock, ["gadgets"]);
  }

  // ---- seed an availability facet so the paginated-with-facet case has a
  // filter to preserve across page links ----
  var sfSeed = bShop.searchFacets.create({ query: query, catalog: { list: function () { return Promise.resolve({ rows: [] }); } } });
  await sfSeed.defineFacet({ key: "availability", field: "in_stock", kind: "boolean" });

  var handle = await _bootApp({
    catalog:        catalog,
    cart:           cart,
    collections:    collections,
    searchSynonyms: searchSynonyms,
    searchFacets:   searchFacets,
  });

  var HOST = "shop.example";
  var hdr  = { host: HOST };

  try {
    // ====================================================================
    // BUG 1 — honest result count + reachable second page
    // ====================================================================
    var p1 = await helpers.httpRequest({ port: handle.port, path: "/search?q=widget", headers: hdr });
    check("search page 1 then 200", p1.status === 200);
    // The result-count copy must report the REAL total (30), not the
    // 24-card page slice. The old bug printed "Showing 24 matches".
    check("count reports the real total (30), not the page length",
      p1.body.indexOf("Showing 30 matches") !== -1);
    check("count does NOT report the truncated page length (24)",
      p1.body.indexOf("Showing 24 matches") === -1);

    var page1Slugs = _slugsOf(p1.body);
    check("page 1 shows exactly the page size (24) cards", page1Slugs.length === 24);
    check("page 1 renders a pagination nav", p1.body.indexOf("search-pagination") !== -1);
    check("page 1 links to page 2", p1.body.indexOf("page=2") !== -1);
    check("page 1 has no previous link (disabled)", p1.body.indexOf("search-pagination__prev is-disabled") !== -1);

    // Page 2 must be reachable AND show the products beyond the first 24
    // (the old hard cap made products #25–30 unreachable entirely).
    var p2 = await helpers.httpRequest({ port: handle.port, path: "/search?q=widget&page=2", headers: hdr });
    check("search page 2 then 200", p2.status === 200);
    check("page 2 still reports the real total (30)",
      p2.body.indexOf("Showing 30 matches") !== -1);
    var page2Slugs = _slugsOf(p2.body);
    check("page 2 shows the remaining 6 cards", page2Slugs.length === 6);
    // No overlap between page 1 and page 2 — the slice actually advanced.
    var overlap = page2Slugs.filter(function (s) { return page1Slugs.indexOf(s) !== -1; });
    check("page 2 products are disjoint from page 1", overlap.length === 0);
    // Page 1 + page 2 together reach all 30 distinct widgets — products
    // beyond the first 24 are no longer discarded by a hard cap.
    var union = {};
    page1Slugs.concat(page2Slugs).forEach(function (s) { union[s] = true; });
    check("page 1 + page 2 reach all 30 distinct matches", Object.keys(union).length === 30);
    check("page 2 has a previous link", p2.body.indexOf("search-pagination__prev\" href") !== -1 || p2.body.indexOf("rel=\"prev\"") !== -1);
    check("page 2 next is disabled (last page)", p2.body.indexOf("search-pagination__next is-disabled") !== -1);

    // ---- facet state preserved across page links ----
    // availability=true matches 27 in-stock widgets → spans 2 pages. The
    // page links + count must carry the facet.
    var f1 = await helpers.httpRequest({ port: handle.port, path: "/search?q=widget&availability=true", headers: hdr });
    check("faceted page 1 then 200", f1.status === 200);
    check("faceted count reports the filtered total (27)",
      f1.body.indexOf("Showing 27 matches") !== -1);
    // The page-2 link must keep BOTH q and the facet so paging doesn't drop
    // the filter.
    check("faceted page link keeps q=widget", f1.body.indexOf("q=widget") !== -1);
    check("faceted page link keeps availability=true", /href="[^"]*availability=true[^"]*page=2"/.test(f1.body) || /href="[^"]*page=2[^"]*availability=true"/.test(f1.body) || f1.body.indexOf("availability=true&amp;page=2") !== -1);

    var f2 = await helpers.httpRequest({ port: handle.port, path: "/search?q=widget&availability=true&page=2", headers: hdr });
    check("faceted page 2 then 200", f2.status === 200);
    check("faceted page 2 keeps the filtered total (27)", f2.body.indexOf("Showing 27 matches") !== -1);
    var f2Slugs = _slugsOf(f2.body);
    check("faceted page 2 shows the remaining 3 in-stock widgets", f2Slugs.length === 3);
    // The out-of-stock widgets (28–30) must NOT leak onto the filtered page.
    check("faceted page 2 excludes out-of-stock widget-30", f2Slugs.indexOf("widget-30") === -1);

    // ---- an out-of-range page clamps to the last page (no empty grid) ----
    var pBeyond = await helpers.httpRequest({ port: handle.port, path: "/search?q=widget&page=99", headers: hdr });
    check("out-of-range page then 200", pBeyond.status === 200);
    check("out-of-range page serves the last page (6 cards)", _slugsOf(pBeyond.body).length === 6);

    // ====================================================================
    // BUG 2 — indexable pages carry an absolute canonical + og:url
    // ====================================================================
    var colIndex = await helpers.httpRequest({ port: handle.port, path: "/collections", headers: hdr });
    check("collections index then 200", colIndex.status === 200);
    var colIndexCanon = _canonical(colIndex.body);
    check("collections index canonical is absolute + correct",
      colIndexCanon === "https://" + HOST + "/collections");
    check("collections index og:url matches the canonical",
      _ogUrl(colIndex.body) === "https://" + HOST + "/collections");
    check("collections index canonical is NOT empty", colIndexCanon !== "" && colIndexCanon != null);

    var col = await helpers.httpRequest({ port: handle.port, path: "/collections/gadgets", headers: hdr });
    check("collection browse then 200", col.status === 200);
    check("collection browse canonical is absolute + correct",
      _canonical(col.body) === "https://" + HOST + "/collections/gadgets");
    check("collection browse og:url matches the canonical",
      _ogUrl(col.body) === "https://" + HOST + "/collections/gadgets");

    // The collection browse page is indexable — it must NOT carry a noindex
    // robots meta (that would defeat the canonical we just added).
    check("collection browse is indexable (no noindex meta)",
      col.body.indexOf("name=\"robots\" content=\"noindex") === -1);

    // ---- search (already-correct) canonical sanity ----
    check("search page canonical is absolute + correct",
      _canonical(p1.body) === "https://" + HOST + "/search");

    // ---- cart is intentionally noindex (robots.txt-disallowed) ----
    // A guest cart (no session cookie) renders from the container fallback
    // path; it must carry a noindex robots meta rather than rely on
    // robots.txt alone.
    var cartRes = await helpers.httpRequest({ port: handle.port, path: "/cart", headers: hdr });
    check("cart then 200", cartRes.status === 200);
    check("cart carries a noindex robots meta",
      /<meta name="robots" content="noindex,nofollow">/.test(cartRes.body));
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
