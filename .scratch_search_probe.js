"use strict";
// READ-ONLY probe: exercises the search lib primitives in-memory with a
// fake query() backend. No server, no listener.
var synonymsMod = require("./lib/search-synonyms.js");
var facetsMod   = require("./lib/search-facets.js");
var rankingMod  = require("./lib/search-ranking.js");

// Fake DB tables.
var tables = {
  search_synonym_groups: [],
  search_typos: [],
  search_stopwords: [],
  search_facets: [],
  search_facet_usage: [],
  search_weight_sets: [],
  search_manual_pins: [],
  search_events: [],
};

function fakeQuery(sql, params) {
  // Minimal SQL interpreter for the SELECTs the rewrite/getFacets paths run.
  if (/FROM search_synonym_groups/i.test(sql) && /^SELECT/i.test(sql.trim())) {
    return Promise.resolve({ rows: tables.search_synonym_groups.slice() });
  }
  if (/FROM search_typos/i.test(sql) && /^SELECT/i.test(sql.trim())) {
    return Promise.resolve({ rows: tables.search_typos.slice() });
  }
  if (/FROM search_stopwords/i.test(sql) && /^SELECT/i.test(sql.trim())) {
    return Promise.resolve({ rows: tables.search_stopwords.slice() });
  }
  if (/FROM search_facets/i.test(sql) && /^SELECT/i.test(sql.trim())) {
    return Promise.resolve({ rows: tables.search_facets.slice() });
  }
  if (/FROM search_weight_sets/i.test(sql) && /active = 1/i.test(sql)) {
    return Promise.resolve({ rows: tables.search_weight_sets.filter(function(w){return w.active===1 && w.archived_at==null;}) });
  }
  if (/FROM search_weight_sets/i.test(sql) && /WHERE slug/i.test(sql)) {
    return Promise.resolve({ rows: tables.search_weight_sets.filter(function(w){return w.slug===params[0];}) });
  }
  if (/FROM search_manual_pins/i.test(sql)) {
    return Promise.resolve({ rows: tables.search_manual_pins.filter(function(p){return p.query===params[0];}) });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

// Seed: a bidirectional synonym group tee<->t-shirt, a price numeric_range facet, an in_stock boolean facet, a brand categorical facet.
tables.search_synonym_groups.push({ slug:"tee", kind:"bidirectional", terms_json: JSON.stringify(["tee","t-shirt"]) });
tables.search_facets.push({ key:"brand", field:"vendor", kind:"categorical", buckets_json:null, display_limit:null, active:1, archived_at:null, created_at:1, updated_at:1 });
tables.search_facets.push({ key:"price", field:"price_minor", kind:"numeric_range", buckets_json: JSON.stringify([{label:"Under $25",min:null,max:2500},{label:"$25+",min:2500,max:null}]), display_limit:null, active:1, archived_at:null, created_at:2, updated_at:2 });
tables.search_facets.push({ key:"in_stock", field:"in_stock", kind:"boolean", buckets_json:null, display_limit:null, active:1, archived_at:null, created_at:3, updated_at:3 });

// A fake universe (decorated rows).
var UNIVERSE = [
  { id:"p1", title:"Red Tee", vendor:"Nike", price_minor:2000, in_stock:true },
  { id:"p2", title:"Blue Tee", vendor:"Adidas", price_minor:3000, in_stock:false },
  { id:"p3", title:"Green Tee", vendor:"Nike", price_minor:null, in_stock:true },
];

async function main() {
  var syn = synonymsMod.create({ query: fakeQuery });
  var rw = await syn.rewrite("Tees");
  console.log("REWRITE 'Tees':", JSON.stringify(rw));

  // facets factory takes a catalog
  var facetCatalog = { list: function(){ return Promise.resolve({ rows: UNIVERSE }); } };
  var sf = facetsMod.create({ query: fakeQuery, catalog: facetCatalog });
  var groups = await sf.getFacets({ query:"tee", applied_filters:{} });
  console.log("FACETS (no filter):", JSON.stringify(groups));

  // Apply a brand=Nike filter and recount + preview
  var filt = { brand:["Nike"] };
  var g2 = await sf.getFacets({ query:"tee", applied_filters: filt });
  console.log("FACETS (brand=Nike):", JSON.stringify(g2));
  var pv = await sf.previewQuery({ query:"tee", filters: filt, sample: 24 });
  console.log("PREVIEW (brand=Nike) total/sampleIds:", pv.total, pv.sample.map(function(r){return r.id;}));

  // numeric_range filter with a null-price product (p3) — should be excluded
  var pv2 = await sf.previewQuery({ query:"tee", filters: { price:["Under $25"] }, sample:24 });
  console.log("PREVIEW price<25 total/ids:", pv2.total, pv2.sample.map(function(r){return r.id;}));

  // in_stock boolean filter
  var pvIs = await sf.previewQuery({ query:"tee", filters: { in_stock:["true"] }, sample:24 });
  console.log("PREVIEW in_stock=true total/ids:", pvIs.total, pvIs.sample.map(function(r){return r.id;}));

  // Garbage filter value reaching previewQuery (what _parseSearchFilters would have dropped is fine; but test a stale removed-facet key)
  var pvStale = await sf.previewQuery({ query:"tee", filters: { brand:["Nike"], removed_facet:["x"] }, sample:24 });
  console.log("PREVIEW stale-facet total:", pvStale.total);

  // ranking: define weights + pin p3 to position 1
  tables.search_weight_sets.push({ slug:"w", name:"W", weights_json: JSON.stringify({ in_stock:1 }), active:1, archived_at:null, created_at:1, updated_at:1 });
  tables.search_manual_pins.push({ query:"tee", product_id:"p3", position:1, created_at:1, updated_at:1 });
  var rank = rankingMod.create({ query: fakeQuery });
  var projected = UNIVERSE.map(function(r){ return Object.assign({}, r, { product_id:r.id, signals:{ in_stock:r.in_stock===true, price_minor: typeof r.price_minor==="number"?r.price_minor:0 } }); });
  var ranked = await rank.applyToResults({ query:"tee", results: projected });
  console.log("RANKED ids:", ranked.map(function(r){return r.product_id + "(" + r._score + (r._pinned?",pin":"") + ")";}));
}
main().then(function(){ console.log("PROBE DONE"); }).catch(function(e){ console.error("PROBE ERROR:", e && e.stack || e); });
