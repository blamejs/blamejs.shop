"use strict";
var nodeFs = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");
var bShop = require("./lib");

function _split(t){ return t.replace(/--[^\n]*\n/g,"\n").split(/;\s*(?:\n|$)/).map(function(s){return s.trim();}).filter(Boolean); }
var MIGS = ["0001_catalog.sql","0002_cart.sql","0003_order.sql","0206_orders_email_hash.sql"];
// find returns migration
var dir = nodePath.resolve(__dirname,"..","migrations-d1");
var files = nodeFs.readdirSync(dir).filter(function(n){return /return/i.test(n)&&/\.sql$/.test(n);});
console.log("returns migs:", files);
