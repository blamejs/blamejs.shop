"use strict";
var facetsMod  = require("./lib/search-facets.js");
var rankingMod = require("./lib/search-ranking.js");

// Build a 30-row universe with a brand facet; pin a low-score Nike product to position 1.
var UNIVERSE = [];
for (var i=0;i<30;i++){
  UNIVERSE.push({ id:"p"+(i<10?"0":"")+i, title:"Item "+i, vendor:(i%2===0?"Nike":"Adidas"), price_minor:1000+i, in_stock:(i%3!==0) });
}
var tables = {
  facets:[{ key:"brand", field:"vendor", kind:"categorical", buckets_json:null, display_limit:null, active:1, archived_at:null, created_at:1, updated_at:1 }],
  weights:[{ slug:"w", name:"W", weights_json: JSON.stringify({ price_minor: 0.001 }), active:1, archived_at:null, created_at:1, updated_at:1 }],
  pins:[{ query:"item", product_id:"p29", position:1, created_at:1, updated_at:1 }], // p29 is Adidas (odd) — will it survive a brand=Nike filter?
};
function fq(sql, params){
  if (/search_facets/i.test(sql)) return Promise.resolve({rows:tables.facets});
  if (/search_weight_sets/i.test(sql) && /active = 1/i.test(sql)) return Promise.resolve({rows:tables.weights.filter(w=>w.active===1)});
  if (/search_weight_sets/i.test(sql)) return Promise.resolve({rows:tables.weights.filter(w=>w.slug===params[0])});
  if (/search_manual_pins/i.test(sql)) return Promise.resolve({rows:tables.pins.filter(p=>p.query===params[0])});
  return Promise.resolve({rows:[]});
}
var SIZE=24;

// ---- CONTAINER path: rerank full universe, then facet-filter+window ----
async function containerPath(filters, page){
  var rank = rankingMod.create({ query: fq });
  var projected = UNIVERSE.map(r=>Object.assign({},r,{product_id:r.id, signals:{ in_stock:r.in_stock===true, price_minor: typeof r.price_minor==="number"?r.price_minor:0 }}));
  var ranked = await rank.applyToResults({ query:"item", results: projected });
  var universe = ranked.length===UNIVERSE.length ? ranked : projected;
  var facetCatalog = { list:function(){ return Promise.resolve({rows:universe}); } };
  var sf = facetsMod.create({ query: fq, catalog: facetCatalog });
  var total = (await sf.previewQuery({ query:"item", filters: filters, sample:0 })).total;
  var clamped = Math.min(Math.max(1,page), Math.max(1,Math.ceil(total/SIZE)));
  var pv = await sf.previewQuery({ query:"item", filters: filters, sample:SIZE, offset:(clamped-1)*SIZE });
  return { total: total, ids: pv.sample.map(r=>r.id) };
}

// ---- EDGE path: facet-filter, then rerank, then window ----
// mirror via the edge ESM modules
async function edgePath(filters, page){
  var sr = await import("./worker/data/search-ranking.js");
  var sfac = await import("./worker/data/search-faceting.js");
  var matched = sfac.applyFilters(tables.facets, UNIVERSE, filters);
  var ranking = await sr.loadSearchRanking({ prepare:function(sql){ return { bind:function(){ var p=Array.prototype.slice.call(arguments); return { all:function(){ return fq(sql,p).then(r=>({results:r.rows})); } }; } }; } }, sr.normalizeRankingQuery("item"));
  var projected = sr.projectForRanking(matched);
  var ranked = sr.applyRanking(ranking.weights, ranking.pins, projected);
  if (ranked.length===matched.length) matched = ranked;
  var total = matched.length;
  var clamped = Math.min(Math.max(1,page), Math.max(1,Math.ceil(total/SIZE)));
  var ids = matched.slice((clamped-1)*SIZE, clamped*SIZE).map(r=>r.id);
  return { total: total, ids: ids };
}

async function main(){
  for (const f of [ {}, { brand:["Nike"] }, { brand:["Adidas"] } ]){
    for (const pg of [1,2]){
      var c = await containerPath(f, pg);
      var e = await edgePath(f, pg);
      var same = JSON.stringify(c.ids)===JSON.stringify(e.ids) && c.total===e.total;
      console.log("filter="+JSON.stringify(f)+" page="+pg+" SAME="+same+" total(c/e)="+c.total+"/"+e.total);
      if(!same){ console.log("  container:", c.ids.join(",")); console.log("  edge:     ", e.ids.join(",")); }
    }
  }
}
main().then(()=>console.log("PARITY DONE")).catch(e=>console.error("ERR", e&&e.stack||e));
