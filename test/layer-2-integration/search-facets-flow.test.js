"use strict";
/**
 * Search facets + synonyms — full HTTP integration of the storefront
 * /search page.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * searchFacets factory + searchSynonyms instance, against one in-memory
 * `node:sqlite` DB loaded from the live migrations. Seeds three products
 * across two collections with mixed stock + price, plus a `tee` →
 * `t-shirt` synonym group and a price / collection / availability facet,
 * then exercises facet render + counts, narrowing, multi-facet combine,
 * synonym match, filters surviving across requests, garbage facet values,
 * out-of-range price params, unknown facet keys, the empty state, and
 * injection-safe reflection of the query.
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-srch-"));
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

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var collections = bShop.collections.create({ query: query, catalog: catalog, cursorSecret: "srch-flow-cursor" });
  var searchSynonyms = bShop.searchSynonyms.create({ query: query });
  var searchFacets = function (perRequestCatalog) {
    return bShop.searchFacets.create({ query: query, catalog: perRequestCatalog });
  };

  // ---- seed catalog ----
  // Three "t-shirt" products so a query for the synonym "tee" matches:
  //   * Cotton Tee   — $19.99, in stock,     collection "summer"
  //   * Wool T-Shirt  — $49.99, in stock,     collections "summer" + "winter"
  //   * Linen T-Shirt — $89.99, OUT of stock, collection "winter"
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
    "VALUES ('summer', 'manual', 'Summer', '', 'manual', ?1, ?1), ('winter', 'manual', 'Winter', '', 'manual', ?1, ?1)",
    [now],
  );

  await _seedProduct("cotton-tee",  "Cotton Tee",   "A soft cotton t-shirt.", 1999, 10, ["summer"]);
  await _seedProduct("wool-shirt",  "Wool T-Shirt", "A warm wool t-shirt.",   4999,  5, ["summer", "winter"]);
  await _seedProduct("linen-shirt", "Linen T-Shirt", "A light linen t-shirt.", 8999,  0, ["winter"]);

  // A product that should NEVER match a "tee" search (no t-shirt / tee
  // term) — proves synonym expansion doesn't over-match.
  await _seedProduct("oak-desk", "Oak Desk", "A sturdy oak writing desk.", 29999, 3, []);

  // ---- seed synonyms ----
  // bidirectional {tee, t-shirt} so a query for "tee" expands to
  // "t-shirt" (which the product titles / descriptions carry).
  await searchSynonyms.addGroup({ slug: "tee-synonyms", kind: "bidirectional", terms: ["tee", "t-shirt"] });
  // typo: "tshrit" -> "t-shirt".
  await searchSynonyms.addTypo({ misspelling: "tshrit", correction: "t-shirt" });

  // ---- seed facets ----
  // The facet registry lives in the DB; a throwaway instance with an
  // empty catalog adapter authors the definitions (the catalog is only
  // consulted by getFacets / previewQuery, not by defineFacet).
  var sfSeed = bShop.searchFacets.create({ query: query, catalog: { list: function () { return Promise.resolve({ rows: [] }); } } });
  await sfSeed.defineFacet({ key: "collection", field: "collection", kind: "categorical" });
  await sfSeed.defineFacet({ key: "availability", field: "in_stock", kind: "boolean" });
  await sfSeed.defineFacet({
    key: "price", field: "price_minor", kind: "numeric_range",
    buckets: [
      { label: "Under $25", min: null, max: 2500 },
      { label: "$25–$75",   min: 2500, max: 7500 },
      { label: "$75+",      min: 7500, max: null },
    ],
  });

  var handle = await _bootApp({
    catalog:        catalog,
    cart:           cart,
    collections:    collections,
    searchSynonyms: searchSynonyms,
    searchFacets:   searchFacets,
  });

  try {
    // ---- synonym match: "tee" expands to "t-shirt" ----
    var tee = await helpers.httpRequest({ port: handle.port, path: "/search?q=tee" });
    check("tee search then 200",                 tee.status === 200);
    check("tee matches Cotton Tee",              tee.body.indexOf("Cotton Tee") !== -1);
    check("tee matches Wool T-Shirt",            tee.body.indexOf("Wool T-Shirt") !== -1);
    check("tee matches Linen T-Shirt",           tee.body.indexOf("Linen T-Shirt") !== -1);
    check("tee does NOT match Oak Desk",         tee.body.indexOf("Oak Desk") === -1);
    // Pure synonym expansion ("tee" → also match "t-shirt") doesn't
    // rewrite the displayed query, so no "Showing results for" note
    // appears here — that note is reserved for typo / stopword
    // corrections that change the canonical query text (asserted on the
    // typo case below).

    // ---- facet render + counts ----
    check("renders the collection facet group",  tee.body.indexOf("collection") !== -1 || tee.body.indexOf("Collection") !== -1);
    check("renders a facet sidebar",             tee.body.indexOf("search-facets") !== -1);
    check("renders the price facet bucket",      tee.body.indexOf("Under $25") !== -1);
    check("renders the availability facet",      tee.body.indexOf("facet-group") !== -1);
    // summer has 2 of the 3 t-shirts; winter has 2. The facet link
    // carries the toggle param.
    check("collection facet links by param",     tee.body.indexOf("collection=summer") !== -1);
    check("collection facet links winter",        tee.body.indexOf("collection=winter") !== -1);

    // ---- single-facet narrowing: collection=winter ----
    var winter = await helpers.httpRequest({ port: handle.port, path: "/search?q=tee&collection=winter" });
    check("winter facet then 200",               winter.status === 200);
    check("winter shows Wool T-Shirt",           winter.body.indexOf("Wool T-Shirt") !== -1);
    check("winter shows Linen T-Shirt",          winter.body.indexOf("Linen T-Shirt") !== -1);
    check("winter hides Cotton Tee",             winter.body.indexOf("Cotton Tee") === -1);
    check("winter shows an active-filter chip",  winter.body.indexOf("search-active-filters") !== -1);
    check("winter offers clear-all",             winter.body.indexOf("Clear all filters") !== -1);

    // ---- multi-facet combine (AND across groups): winter + in stock ----
    var winterInStock = await helpers.httpRequest({ port: handle.port, path: "/search?q=tee&collection=winter&availability=true" });
    check("winter+instock then 200",             winterInStock.status === 200);
    check("winter+instock shows Wool T-Shirt",   winterInStock.body.indexOf("Wool T-Shirt") !== -1);
    check("winter+instock hides Linen (no stock)", winterInStock.body.indexOf("Linen T-Shirt") === -1);
    check("winter+instock hides Cotton (summer)", winterInStock.body.indexOf("Cotton Tee") === -1);

    // ---- price range narrowing ----
    var cheap = await helpers.httpRequest({ port: handle.port, path: "/search?q=tee&price=" + encodeURIComponent("Under $25") });
    check("price facet then 200",                cheap.status === 200);
    check("cheap shows Cotton Tee ($19.99)",     cheap.body.indexOf("Cotton Tee") !== -1);
    check("cheap hides Wool ($49.99)",           cheap.body.indexOf("Wool T-Shirt") === -1);

    // ---- filters survive across links (pagination/link carry) ----
    // The facet links + chips in the winter response must keep the
    // q + the active filter in their hrefs.
    check("facet links keep q=tee",              winter.body.indexOf("q=tee") !== -1);
    check("availability toggle keeps collection", winter.body.indexOf("availability=true") !== -1 || winter.body.indexOf("availability=false") !== -1);

    // ---- garbage facet value ignored (no 500) ----
    var garbage = await helpers.httpRequest({ port: handle.port, path: "/search?q=tee&collection=does-not-exist" });
    check("garbage facet value then 200",        garbage.status === 200);
    check("garbage facet narrows to empty",      garbage.body.indexOf("Cotton Tee") === -1 && garbage.body.indexOf("Wool T-Shirt") === -1);
    check("garbage facet shows empty + clear",   garbage.body.indexOf("Clear filters") !== -1 || garbage.body.indexOf("Clear all filters") !== -1);

    // ---- unknown facet key ignored (no 500) ----
    var unknownKey = await helpers.httpRequest({ port: handle.port, path: "/search?q=tee&made_up_facet=x" });
    check("unknown facet key then 200",          unknownKey.status === 200);
    check("unknown facet key still shows tees",  unknownKey.body.indexOf("Cotton Tee") !== -1);

    // ---- out-of-range / nonsense price param ignored ----
    var badPrice = await helpers.httpRequest({ port: handle.port, path: "/search?q=tee&price=" + encodeURIComponent("99 bottles") });
    check("nonsense price then 200",             badPrice.status === 200);
    check("nonsense price narrows to empty grid", badPrice.body.indexOf("Cotton Tee") === -1);

    // ---- empty results (no facets) ----
    var noMatch = await helpers.httpRequest({ port: handle.port, path: "/search?q=" + encodeURIComponent("nonexistentwidget") });
    check("no-match then 200",                   noMatch.status === 200);
    // The heading text is HTML-escaped by the strict renderer (the
    // apostrophe becomes &#x27;), so match on the surrounding class.
    check("no-match shows empty state",          noMatch.body.indexOf("search-empty") !== -1 && noMatch.body.indexOf("carry that yet") !== -1);

    // ---- no query ----
    var noQuery = await helpers.httpRequest({ port: handle.port, path: "/search" });
    check("no-query then 200",                   noQuery.status === 200);
    check("no-query prompts for a query",        noQuery.body.indexOf("What are you looking for?") !== -1);
    check("no-query renders no facet sidebar",   noQuery.body.indexOf("search-facets") === -1);

    // ---- injection-safe reflection of the query ----
    var xss = await helpers.httpRequest({ port: handle.port, path: "/search?q=" + encodeURIComponent("<script>alert(1)</script>") });
    check("xss query then 200",                  xss.status === 200);
    check("xss query is escaped, not executed",  xss.body.indexOf("<script>alert(1)</script>") === -1);
    check("xss query reflected escaped",         xss.body.indexOf("&lt;script&gt;") !== -1);

    // ---- synonym typo correction: tshrit -> t-shirt ----
    var typo = await helpers.httpRequest({ port: handle.port, path: "/search?q=tshrit" });
    check("typo search then 200",                typo.status === 200);
    check("typo matches the t-shirts",           typo.body.indexOf("Wool T-Shirt") !== -1);
    check("typo surfaces the correction note",   typo.body.indexOf("Showing results for") !== -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
