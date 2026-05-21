"use strict";
/**
 * storefront-config-wiring — config-backed tax + shipping wrappers.
 *
 * Mirrors the per-request adapter shape `server.js` hands the
 * storefront mount. The wrappers re-read `tax.rules`,
 * `shipping.services`, and `shipping.default_id` from the `config`
 * primitive on every call, rebuilding a fresh
 * `bShop.tax.create({ rules })` / `bShop.shipping.create({ services })`
 * each time so an operator PUT against `/admin/config/:key` takes
 * effect on the next checkout (modulo the 30s read cache).
 *
 * Coverage:
 *   - Seeded `tax.rules` → wrapper applies operator-configured rate
 *   - Seeded `shipping.services` → wrapper quotes operator-configured rates
 *   - Seeded `shipping.default_id` → resolver returns the configured id
 *   - Empty config → documented zero-rate defaults apply
 *   - Cache invalidation: post-seed values surface without restart
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0004_shop_config.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

// Build the same adapter shape `server.js` constructs at storefront
// mount. The wrappers compose `bShop.tax.create` / `bShop.shipping.create`
// per call so each checkout sees the latest config row.
var DEFAULT_TAX_RULES = [];
var DEFAULT_SHIPPING_SERVICES = [
  { id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 0 }] },
];
var DEFAULT_SHIPPING_ID = "std";

function _buildWrappers(config) {
  return {
    tax: {
      name: "configured",
      calculate: async function (ctx) {
        var rules = await config.get("tax.rules", DEFAULT_TAX_RULES);
        return await bShop.tax.create({ rules: rules }).calculate(ctx);
      },
    },
    shipping: {
      name: "configured",
      rates: async function (ctx) {
        var services = await config.get("shipping.services", DEFAULT_SHIPPING_SERVICES);
        return await bShop.shipping.create({ services: services }).rates(ctx);
      },
    },
    defaultShippingId: async function () {
      return await config.get("shipping.default_id", DEFAULT_SHIPPING_ID);
    },
  };
}

async function _taxFromConfig() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q });
  await config.put("tax.rules", [
    { country: "US", state: "CA", rate_bps: 875 },
    { country: "US", state: "NY", rate_bps: 800 },
  ]);
  var wrappers = _buildWrappers(config);
  var r = await wrappers.tax.calculate({
    shipTo:         { country: "US", state: "CA", postal: "94103" },
    subtotal_minor: 10000,
  });
  check("tax wrapper picks up CA rule from config", r.rate_bps === 875);
  check("tax wrapper computes amount",               r.tax_minor === 875);
  check("tax wrapper reports jurisdiction",          r.jurisdiction === "US/CA");
}

async function _taxDefaultsWhenEmpty() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q });
  var wrappers = _buildWrappers(config);
  var r = await wrappers.tax.calculate({
    shipTo:         { country: "US", state: "CA", postal: "94103" },
    subtotal_minor: 10000,
  });
  // Empty rule table → fallback rate_bps = 0.
  check("tax wrapper defaults to zero rate",  r.rate_bps === 0);
  check("tax wrapper defaults to zero amount", r.tax_minor === 0);
}

async function _shippingFromConfig() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q });
  await config.put("shipping.services", [
    {
      id:    "express",
      label: "Express (1-2 days)",
      zones: [{ country: "US", flat_amount_minor: 1500 }],
    },
    {
      id:    "ground",
      label: "Ground",
      zones: [{ country: "US", flat_amount_minor: 595 }],
    },
  ]);
  var wrappers = _buildWrappers(config);
  var quote = await wrappers.shipping.rates({
    shipTo:         { country: "US", postal: "94103" },
    lines:          [{ qty: 1, weight_grams: 250, requires_shipping: true }],
    subtotal_minor: 4999,
  });
  check("shipping wrapper picks up both services from config",  quote.services.length === 2);
  var ids = quote.services.map(function (s) { return s.id; }).sort();
  check("shipping wrapper service ids match config",            ids[0] === "express" && ids[1] === "ground");
  var express = quote.services.filter(function (s) { return s.id === "express"; })[0];
  check("shipping wrapper express amount from config",          express.amount_minor === 1500);
}

async function _shippingDefaultsWhenEmpty() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q });
  var wrappers = _buildWrappers(config);
  var quote = await wrappers.shipping.rates({
    shipTo:         { country: "US", postal: "94103" },
    lines:          [{ qty: 1, weight_grams: 250, requires_shipping: true }],
    subtotal_minor: 4999,
  });
  check("shipping wrapper default returns std",               quote.services.length === 1);
  check("shipping wrapper default service id",                 quote.services[0].id === "std");
  check("shipping wrapper default amount is zero",             quote.services[0].amount_minor === 0);
}

async function _defaultShippingIdFromConfig() {
  var q = _makeQuery();
  var config = bShop.config.create({ query: q });
  var wrappers = _buildWrappers(config);
  check("default_shipping_id falls back to std", (await wrappers.defaultShippingId()) === "std");
  await config.put("shipping.default_id", "express");
  check("default_shipping_id reflects config write", (await wrappers.defaultShippingId()) === "express");
}

async function _taxCacheInvalidationAfterPut() {
  // The config primitive caches reads for 30s; admin writes invalidate
  // the cache key. The wrapper therefore sees the NEW rules on the
  // next checkout without a container restart.
  var q = _makeQuery();
  var config = bShop.config.create({ query: q });
  var wrappers = _buildWrappers(config);
  // First call — empty config, zero-rate default.
  var first = await wrappers.tax.calculate({
    shipTo:         { country: "US", state: "CA", postal: "94103" },
    subtotal_minor: 10000,
  });
  check("first call sees default zero rate", first.rate_bps === 0);
  // Operator writes a rule; next call must see it.
  await config.put("tax.rules", [{ country: "US", state: "CA", rate_bps: 875 }]);
  var second = await wrappers.tax.calculate({
    shipTo:         { country: "US", state: "CA", postal: "94103" },
    subtotal_minor: 10000,
  });
  check("second call sees the just-written rule", second.rate_bps === 875);
}

async function run() {
  await _taxFromConfig();
  await _taxDefaultsWhenEmpty();
  await _shippingFromConfig();
  await _shippingDefaultsWhenEmpty();
  await _defaultShippingIdFromConfig();
  await _taxCacheInvalidationAfterPut();
}

module.exports = { run: run };
