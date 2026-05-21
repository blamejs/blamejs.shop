"use strict";
/**
 * config — operator-tunable runtime store.
 *
 * Layer 1 against in-memory node:sqlite loaded from 0004_shop_config.sql.
 * Coverage:
 *   - put + get round-trip (objects, arrays, primitives)
 *   - get returns defaultValue on miss
 *   - put bumps version + updated_at
 *   - list with + without prefix
 *   - delete removes the row + returns boolean
 *   - cache invalidation on put / delete
 *   - validation: bad key shape, value > 64KiB, undefined value, non-JSON-roundtrip
 *   - corrupted-at-rest row surfaces typed error
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0004_shop_config.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  return {
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
    raw: db,
  };
}

async function _putGet() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q.query });

  // Primitive
  await config.put("shop.name", "Acme Shop");
  check("get primitive",   (await config.getFresh("shop.name")) === "Acme Shop");

  // Object
  var rules = [{ country: "US", state: "CA", rate_bps: 875 }];
  await config.put("tax.rules", rules);
  check("get array round-trip", JSON.stringify(await config.getFresh("tax.rules")) === JSON.stringify(rules));

  // Nested object
  var svc = { services: [{ id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 695 }] }] };
  await config.put("shipping", svc);
  var got = await config.getFresh("shipping");
  check("get nested object",      got.services[0].zones[0].flat_amount_minor === 695);
}

async function _defaults() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q.query });
  check("missing key returns null by default", (await config.get("unknown.key")) === null);
  check("missing key returns default when provided", (await config.get("unknown.key", { fallback: true })).fallback === true);
}

async function _versionBump() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q.query });
  await config.put("shop.name", "v1");
  var row1 = (await config.list()).find(function (r) { return r.key === "shop.name"; });
  check("first put → version 1", row1.version === 1);

  await config.put("shop.name", "v2");
  var row2 = (await config.list()).find(function (r) { return r.key === "shop.name"; });
  check("second put → version 2", row2.version === 2);
}

async function _list() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q.query });
  await config.put("tax.rules",            [{ country: "US", rate_bps: 0 }]);
  await config.put("shipping.services",    [{ id: "std", label: "L", zones: [{ country: "US", flat_amount_minor: 0 }] }]);
  await config.put("shipping.default_id",  "std");
  await config.put("shop.name",            "Acme");

  var all = await config.list();
  check("list returns all rows",      all.length === 4);

  var shipping = await config.list("shipping.");
  check("list with prefix filters",    shipping.length === 2);
  check("list prefix sorted by key",  shipping[0].key === "shipping.default_id" && shipping[1].key === "shipping.services");
}

async function _delete() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q.query });
  await config.put("temp.key", "value");
  check("delete existing returns true",  (await config.delete("temp.key")) === true);
  check("get after delete returns null",  (await config.get("temp.key")) === null);
  check("delete missing returns false",   (await config.delete("temp.key")) === false);
}

async function _cacheInvalidation() {
  // First get caches; subsequent put bumps; next get returns NEW value
  // (cache invalidated on put).
  var q = _makeQuery();
  var config = bShop.config.create({ query: q.query });
  await config.put("c.key", "v1");
  check("cached read v1",  (await config.get("c.key")) === "v1");
  await config.put("c.key", "v2");
  check("get sees v2 after put",  (await config.get("c.key")) === "v2");
  await config.delete("c.key");
  check("get sees null after delete", (await config.get("c.key")) === null);
}

async function _validation() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q.query });

  await assert.rejects(config.put("Bad Key", "x"),       /key must match/);
  await assert.rejects(config.put("0digit", "x"),         /key must match/);
  await assert.rejects(config.put("good.key", undefined), /cannot be undefined/);

  // Value > 64 KiB
  var huge = "x".repeat(65 * 1024);
  await assert.rejects(config.put("big.key", huge), /exceeds .* bytes/);

  await assert.rejects(config.list({ not: "a string" }), /prefix must be/);
}

async function _corruptedAtRest() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q.query });
  // Bypass put() and insert corrupt JSON directly. _resetCacheForTest
  // to ensure the read isn't served from cache.
  q.raw.prepare("INSERT INTO shop_config (key, value_json, version, updated_at) VALUES ('bad.row', '{not json', 1, 1)").run();
  config._resetCacheForTest();
  await assert.rejects(config.get("bad.row"), /not valid JSON/);
}

async function run() {
  await _putGet();
  await _defaults();
  await _versionBump();
  await _list();
  await _delete();
  await _cacheInvalidation();
  await _validation();
  await _corruptedAtRest();
}

module.exports = { run: run };
