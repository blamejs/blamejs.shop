"use strict";
/**
 * Search faceting — edge ↔ container parity.
 *
 * The storefront /search page renders facet chrome + synonym expansion
 * in BOTH substrates: the container drives the canonical
 * `lib/search-facets.js` + `lib/search-synonyms.js` primitives; the
 * Cloudflare Worker can't `require` a CommonJS leaf, so it mirrors the
 * same algorithm in `worker/data/search-faceting.js` (ESM). If the two
 * implementations drift, an operator who flips EDGE_RENDER on/off gets
 * different facet counts / synonym matches for the same query.
 *
 * This test pins the edge mirror to the lib output: same facet
 * definitions + product rows → identical facet groups/counts/selection,
 * and same vocabulary → identical rewrite canonical/expansions. Pure
 * functions only — no DB, no HTTP. The ESM mirror is loaded via dynamic
 * `import()`.
 *
 * It ALSO pins the rendered search markup: the container's
 * `lib/storefront.js#renderSearch` and the edge's
 * `worker/render/search.js#renderSearch` must emit a byte-identical
 * `<main>` region (the facet sidebar, active-filter chips, correction
 * notice, and result grid) for the same facet groups + applied filters +
 * products. The data parity above guarantees the two compute the same
 * facet counts; this guarantees they then PAINT them identically, so a
 * shopper sees the same filter chrome whether the page came off the edge
 * cache or the container.
 */

var path       = require("node:path");
var assert     = require("node:assert");
var nodeModule = require("node:module");
var nodeUrl    = require("node:url");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var manifest = require("../../lib/asset-manifest.json");

// The edge render modules import `asset-manifest.json` with the bare
// `import x from "./asset-manifest.json"` esbuild bundles at build time;
// Node's native loader needs the `type: "json"` import attribute the
// bundler injects. Register a one-shot resolve hook that supplies it so
// the same source runs unbundled here. Mirrors asset-fingerprint.test.js.
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

// Pull the `<main id="main">…</main>` region out of a full HTML document.
// The chrome outside it (head asset URLs, currency switcher, copyright
// year) is exercised by asset-fingerprint.test.js; this comparison is
// scoped to the search body the faceting feature owns.
function _mainRegion(html) {
  var m = html.match(/<main id="main">([\s\S]*?)<\/main>/);
  return m ? m[1] : null;
}

// In-memory query stub backed by a plain object store, so the lib
// primitives (which expect a `{ rows, rowCount }` async query) run
// without a real DB. Only the tables these two primitives touch are
// modelled.
function _memQuery() {
  var facets = {};   // key -> row
  var groups = {};   // slug -> row
  var typos  = {};   // misspelling -> row
  var stops  = {};   // word -> row
  return async function (sql, params) {
    params = params || [];
    var s = sql.replace(/\s+/g, " ").trim();
    // search_facets
    if (/^INSERT INTO search_facets /.test(s)) {
      facets[params[0]] = {
        key: params[0], field: params[1], kind: params[2], buckets_json: params[3],
        display_limit: params[4], active: 1, archived_at: null, created_at: params[5], updated_at: params[5],
      };
      return { rows: [], rowCount: 1 };
    }
    if (/FROM search_facets WHERE key = /.test(s)) {
      var fr = facets[params[0]];
      return { rows: fr ? [fr] : [], rowCount: fr ? 1 : 0 };
    }
    if (/FROM search_facets WHERE archived_at IS NULL AND active = 1/.test(s)) {
      return { rows: Object.keys(facets).map(function (k) { return facets[k]; }), rowCount: Object.keys(facets).length };
    }
    if (/FROM search_facets /.test(s)) {
      return { rows: Object.keys(facets).map(function (k) { return facets[k]; }), rowCount: Object.keys(facets).length };
    }
    // search_synonym_groups
    if (/^INSERT INTO search_synonym_groups /.test(s)) {
      groups[params[0]] = { slug: params[0], kind: params[1], terms_json: params[2], created_at: params[3], updated_at: params[3] };
      return { rows: [], rowCount: 1 };
    }
    if (/FROM search_synonym_groups WHERE slug = /.test(s)) {
      var gr = groups[params[0]];
      return { rows: gr ? [gr] : [], rowCount: gr ? 1 : 0 };
    }
    if (/FROM search_synonym_groups/.test(s)) {
      return { rows: Object.keys(groups).map(function (k) { return groups[k]; }), rowCount: Object.keys(groups).length };
    }
    // search_typos (upsert)
    if (/^INSERT INTO search_typos /.test(s)) {
      typos[params[0]] = { misspelling: params[0], correction: params[1], created_at: params[2] };
      return { rows: [], rowCount: 1 };
    }
    if (/FROM search_typos/.test(s)) {
      return { rows: Object.keys(typos).map(function (k) { return typos[k]; }), rowCount: Object.keys(typos).length };
    }
    // search_stopwords
    if (/^INSERT INTO search_stopwords /.test(s)) {
      stops[params[0]] = { word: params[0], added_at: params[1] };
      return { rows: [], rowCount: 1 };
    }
    if (/FROM search_stopwords/.test(s)) {
      return { rows: Object.keys(stops).map(function (k) { return stops[k]; }), rowCount: Object.keys(stops).length };
    }
    return { rows: [], rowCount: 0 };
  };
}

// Strip the `selected` flag normalisation differences: both sides set
// `selected` from the applied set, so compare the full option shape.
function _normFacets(groups) {
  return groups.map(function (g) {
    return {
      key: g.key, label: g.label, kind: g.kind,
      options: g.options.map(function (o) {
        return { value: o.value, label: o.label, count: o.count, selected: !!o.selected };
      }),
    };
  });
}

async function _run() {
  // worker/ is excluded from the container build context (.dockerignore), so
  // worker/data/search-faceting.js isn't present in the in-image smoke gate.
  // Skip the edge/container parity there; it's covered by the full-tree CI run
  // where worker/ IS present. A worker-importing test left unguarded fails the
  // in-image `RUN node test/smoke.js`, which fails the Docker build and blocks
  // every container deploy.
  var fs = require("node:fs");
  var edgePath = path.resolve(__dirname, "..", "..", "worker", "data", "search-faceting.js");
  if (!fs.existsSync(edgePath)) return;
  var edge = await import("file://" + edgePath.replace(/\\/g, "/"));

  // ---- facet parity ----
  var query   = _memQuery();
  var ROWS = [
    { id: "p1", collection: ["summer"],            price_minor: 1999, in_stock: true },
    { id: "p2", collection: ["summer", "winter"],  price_minor: 4999, in_stock: true },
    { id: "p3", collection: ["winter"],            price_minor: 8999, in_stock: false },
    { id: "p4", collection: [],                    price_minor: null, in_stock: true },
  ];
  var libFacets = bShop.searchFacets.create({
    query:   query,
    catalog: { list: function () { return Promise.resolve({ rows: ROWS }); } },
  });
  await libFacets.defineFacet({ key: "collection", field: "collection", kind: "categorical" });
  await libFacets.defineFacet({ key: "availability", field: "in_stock", kind: "boolean" });
  await libFacets.defineFacet({
    key: "price", field: "price_minor", kind: "numeric_range",
    buckets: [
      { label: "Under $25", min: null, max: 2500 },
      { label: "$25–$75",   min: 2500, max: 7500 },
      { label: "$75+",      min: 7500, max: null },
    ],
  });

  // The edge mirror's loaded-definition shape (what loadSearchFacets
  // would produce): same fields the lib hydrates.
  var edgeDefs = [
    { key: "collection",   field: "collection",  kind: "categorical",  buckets: null, display_limit: null },
    { key: "availability", field: "in_stock",    kind: "boolean",      buckets: null, display_limit: null },
    { key: "price",        field: "price_minor", kind: "numeric_range",
      buckets: [
        { label: "Under $25", min: null, max: 2500 },
        { label: "$25–$75",   min: 2500, max: 7500 },
        { label: "$75+",      min: 7500, max: null },
      ], display_limit: null },
  ];

  var cases = [
    {},                                   // no filters
    { collection: ["winter"] },           // single categorical
    { collection: ["winter"], availability: ["true"] }, // multi-group AND
    { price: ["Under $25"] },             // numeric_range
    { collection: ["does-not-exist"] },   // garbage value
  ];
  for (var c = 0; c < cases.length; c += 1) {
    var libGroups  = _normFacets(await libFacets.getFacets({ query: "x", applied_filters: cases[c] }));
    var edgeGroups = _normFacets(edge.computeFacets(edgeDefs, ROWS, cases[c]));
    assert.deepStrictEqual(edgeGroups, libGroups,
      "facet parity case " + JSON.stringify(cases[c]));
    check("facet parity " + JSON.stringify(cases[c]), true);

    // applyFilters (edge result narrowing) must match the lib's
    // previewQuery passing set (by id, same order).
    var libPreview = await libFacets.previewQuery({ query: "x", filters: cases[c], sample: 100 });
    var libIds  = libPreview.sample.map(function (r) { return r.id; }).sort();
    var edgeIds = edge.applyFilters(edgeDefs, ROWS, cases[c]).map(function (r) { return r.id; }).sort();
    assert.deepStrictEqual(edgeIds, libIds, "narrowing parity case " + JSON.stringify(cases[c]));
    check("narrowing parity " + JSON.stringify(cases[c]), true);
  }

  // ---- synonym rewrite parity ----
  var synQuery = _memQuery();
  var libSyn = bShop.searchSynonyms.create({ query: synQuery });
  await libSyn.addGroup({ slug: "tee-synonyms", kind: "bidirectional", terms: ["tee", "t-shirt"] });
  await libSyn.addGroup({ slug: "phone-canon", kind: "directional", terms: ["i-phone", "iphone"] });
  await libSyn.addTypo({ misspelling: "tshrit", correction: "t-shirt" });
  await libSyn.addStopword("the");

  var vocab = {
    groups: [
      { kind: "bidirectional", terms: ["tee", "t-shirt"] },
      { kind: "directional",   terms: ["i-phone", "iphone"] },
    ],
    typos:     { tshrit: "t-shirt" },
    stopwords: { the: true },
  };

  var queries = ["tee", "the tee", "tshrit", "i-phone", "iphone", "running shoes", "the", "  ", "<script>"];
  for (var q = 0; q < queries.length; q += 1) {
    var libR  = await libSyn.rewrite(queries[q]);
    var edgeR = edge.rewriteQuery(queries[q], vocab);
    assert.strictEqual(edgeR.canonical, libR.canonical, "rewrite canonical parity: " + JSON.stringify(queries[q]));
    assert.deepStrictEqual(edgeR.expansions.slice().sort(), libR.expansions.slice().sort(),
      "rewrite expansions parity: " + JSON.stringify(queries[q]));
    check("rewrite parity " + JSON.stringify(queries[q]), true);
  }

  // ---- rendered-markup parity (container ↔ edge) ----
  // The container and the edge run two separate `renderSearch`
  // implementations against the SAME facet groups / applied filters /
  // products. The painted `<main>` (facet sidebar + active chips +
  // correction notice + result grid) must be byte-identical so a shopper
  // gets the same filter chrome whether the page came from the edge cache
  // or the container. The edge module is loaded via dynamic import like
  // the faceting mirror above; absent (in-image smoke where worker/ is
  // excluded), the data parity above still covers the contract.
  var edgeSearchPath = path.resolve(__dirname, "..", "..", "worker", "render", "search.js");
  var fsRender = require("node:fs");
  if (fsRender.existsSync(edgeSearchPath)) {
    _registerJsonHook();
    var edgeRender = await import(nodeUrl.pathToFileURL(edgeSearchPath).href);

    // Two facet groups computed off a small product set, so the markup
    // carries multi-group sidebar + a selected option + zero-count hiding.
    var renderRows = [
      { slug: "alpha", title: "Alpha Tee",  starting_price_minor: 1999, starting_price_currency: "USD", collection: ["summer"],           price_minor: 1999, in_stock: true,  hero_media: null },
      { slug: "bravo", title: "Bravo Shirt", starting_price_minor: 4999, starting_price_currency: "USD", collection: ["summer", "winter"], price_minor: 4999, in_stock: true,  hero_media: null },
      { slug: "delta", title: "Delta Shirt", starting_price_minor: 8999, starting_price_currency: "USD", collection: ["winter"],           price_minor: 8999, in_stock: false, hero_media: null },
    ];
    var renderDefs = [
      { key: "collection",   field: "collection",  kind: "categorical",  buckets: null, display_limit: null },
      { key: "availability", field: "in_stock",    kind: "boolean",      buckets: null, display_limit: null },
      { key: "price",        field: "price_minor", kind: "numeric_range",
        buckets: [
          { label: "Under $25", min: null, max: 2500 },
          { label: "$25–$75",   min: 2500, max: 7500 },
          { label: "$75+",      min: 7500, max: null },
        ], display_limit: null },
    ];

    // Each case shares one facet-group computation across both renderers
    // so only the PAINT differs. `q` carries an XSS probe + a Unicode
    // value to exercise the shared escape + URL-build path on both sides.
    var renderCases = [
      { label: "facets, no filters",          q: "tee",            filters: {} },
      { label: "single categorical selected", q: "tee",            filters: { collection: ["winter"] } },
      { label: "multi-group AND",             q: "tee",            filters: { collection: ["winter"], availability: ["true"] } },
      { label: "numeric_range selected",      q: "tee",            filters: { price: ["$25–$75"] } },
      { label: "garbage value → empty grid",  q: "tee",            filters: { collection: ["does-not-exist"] } },
      { label: "xss query reflected",         q: "<script>x</script>", filters: { collection: ["summer"] } },
    ];

    for (var rc = 0; rc < renderCases.length; rc += 1) {
      var cse = renderCases[rc];
      var groups   = edge.computeFacets(renderDefs, renderRows, cse.filters);
      var narrowed = edge.applyFilters(renderDefs, renderRows, cse.filters);

      var containerHtml = bShop.storefront.renderSearch({
        q:               cse.q,
        products:        narrowed,
        facets:          groups,
        filters:         cse.filters,
        corrected_query: "",
        shop_name:       "Acme",
        cart_count:      0,
      });
      var edgeHtml = edgeRender.renderSearch({
        q:              cse.q,
        products:       narrowed,
        facets:         groups,
        filters:        cse.filters,
        correctedQuery: "",
        shopName:       "Acme",
        cartCount:      0,
        version:        manifest.version,
      });

      var containerMain = _mainRegion(containerHtml);
      var edgeMain      = _mainRegion(edgeHtml);
      check("render parity (" + cse.label + "): container <main> present", containerMain !== null);
      check("render parity (" + cse.label + "): edge <main> present",      edgeMain !== null);
      assert.strictEqual(edgeMain, containerMain, "render <main> parity: " + cse.label);
      check("render <main> byte-identical (" + cse.label + ")", true);
    }

    // Correction-notice parity — a typo rewrite changes the canonical
    // query, so both renderers must paint the "Showing results for …"
    // notice identically (and escape the corrected term).
    var corrGroups = edge.computeFacets(renderDefs, renderRows, {});
    var corrContainer = _mainRegion(bShop.storefront.renderSearch({
      q: "tshrit", products: renderRows, facets: corrGroups, filters: {},
      corrected_query: "t-shirt", shop_name: "Acme", cart_count: 0,
    }));
    var corrEdge = _mainRegion(edgeRender.renderSearch({
      q: "tshrit", products: renderRows, facets: corrGroups, filters: {},
      correctedQuery: "t-shirt", shopName: "Acme", cartCount: 0, version: manifest.version,
    }));
    check("render parity (correction): notice rendered", corrContainer.indexOf("Showing results for") !== -1);
    assert.strictEqual(corrEdge, corrContainer, "render <main> parity: correction notice");
    check("render <main> byte-identical (correction notice)", true);
  }
}

module.exports = { run: _run };
