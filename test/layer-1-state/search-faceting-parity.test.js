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
 */

var path   = require("node:path");
var assert = require("node:assert");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

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
  var edge = await import(
    "file://" + path.resolve(__dirname, "..", "..", "worker", "data", "search-faceting.js").replace(/\\/g, "/")
  );

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
}

module.exports = { run: _run };
