"use strict";
var synonymsMod = require("./lib/search-synonyms.js");
var tables = { g:[{ slug:"tee", kind:"bidirectional", terms_json: JSON.stringify(["tee","t-shirt"]) }] };
function fq(sql){
  if (/search_synonym_groups/i.test(sql)) return Promise.resolve({rows:tables.g});
  return Promise.resolve({rows:[]});
}
async function main(){
  var syn = synonymsMod.create({ query: fq });
  for (const q of ["tee","tees","t-shirt","shirts","shoes","dresses","running","boxes","glasses","is","buses","does"]) {
    var r = await syn.rewrite(q);
    console.log(JSON.stringify(q), "->", JSON.stringify(r.canonical), "exp:", JSON.stringify(r.expansions));
  }
}
main().catch(function(e){console.error(e);});
