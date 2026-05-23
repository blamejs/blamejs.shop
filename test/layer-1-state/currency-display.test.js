"use strict";
/**
 * currencyDisplay — multi-currency FX rate cache + display conversion.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0029_fx_rates.sql. Pins:
 *
 *   - setRate: float-rate to bps, TTL semantics, upsert on the
 *     (base, quote) primary key, refusal of unsupported currencies.
 *   - getRate: stale flag flips once expires_at < now, null on miss.
 *   - convert: same-currency identity short-circuit, refusal when no
 *     row exists or the row is expired, banker's rounding via
 *     b.money.convert.
 *   - format: en-US, de-DE, ja-JP renderings; JPY zero-decimal correct.
 *   - convertAndFormat: combined happy path + stale fallback.
 *   - cleanupExpired: prunes by cutoff, returns row count.
 *   - bulkSetRates: rejects a batch if ANY row is invalid (no partial
 *     write); upsert preserves row identity.
 *   - supportedCurrencies enforcement.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0029_fx_rates.sql");

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
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

async function _setRate() {
  var fx = bShop.currencyDisplay.create({ query: _makeQuery() });

  var row = await fx.setRate({
    base: "USD", quote: "EUR", rate: 0.92, source: "manual",
  });
  check("setRate echoes base/quote",     row.base === "USD" && row.quote === "EUR");
  check("setRate float to bps",          row.rate_bps === 9200);
  check("setRate default source", (await fx.setRate({
    base: "USD", quote: "GBP", rate: 0.79,
  })).source === "manual");
  check("setRate computes expires_at from default TTL (~24h)",
    row.expires_at - row.fetched_at === 24 * 60 * 60 * 1000);

  // Upsert -- writing the same pair overwrites in place.
  var row2 = await fx.setRate({
    base: "USD", quote: "EUR", rate: 0.95, source: "ecb",
  });
  check("setRate upsert same pair",     row2.rate_bps === 9500);
  var fetched = await fx.getRate("USD", "EUR");
  check("upsert overwrites source",      fetched.source === "ecb");

  // Refusal: identity, unsupported, bad rate.
  await assert.rejects(function () {
    return fx.setRate({ base: "USD", quote: "USD", rate: 1 });
  }, /base and quote must differ/);
  await assert.rejects(function () {
    return fx.setRate({ base: "USD", quote: "ZZZ", rate: 1.5 });
  }, /supportedCurrencies/);
  await assert.rejects(function () {
    return fx.setRate({ base: "USD", quote: "EUR", rate: -1 });
  }, /positive finite/);
  await assert.rejects(function () {
    return fx.setRate({ base: "USD", quote: "EUR", rate: 0 });
  }, /positive finite/);
  await assert.rejects(function () {
    return fx.setRate({ base: "usd", quote: "EUR", rate: 1 });
  }, /ISO 4217/);
}

async function _getRate() {
  var q  = _makeQuery();
  var fx = bShop.currencyDisplay.create({ query: q });

  check("getRate miss returns null", (await fx.getRate("USD", "EUR")) === null);

  await fx.setRate({ base: "USD", quote: "EUR", rate: 0.92, ttlMs: 60000 });
  var fresh = await fx.getRate("USD", "EUR");
  check("getRate fresh has stale:false",   fresh.stale === false);
  check("getRate fresh carries rate_bps",  fresh.rate_bps === 9200);
  check("getRate fresh carries source",    fresh.source === "manual");

  // Hand-rewrite expires_at to the past so the stale path is
  // observable without a clock-skew helper.
  await q("UPDATE fx_rates SET expires_at = ?1 WHERE base_currency = 'USD' AND quote_currency = 'EUR'", [1]);
  var stale = await fx.getRate("USD", "EUR");
  check("getRate expired row has stale:true", stale.stale === true);
  check("getRate stale row still carries rate_bps", stale.rate_bps === 9200);
}

async function _convert() {
  var q  = _makeQuery();
  var fx = bShop.currencyDisplay.create({ query: q });

  // Same-currency identity -- no rate row required, no I/O dispatched.
  var ident = await fx.convert({ amount_minor: 2999, from: "USD", to: "USD" });
  check("convert identity short-circuits",   ident.converted_minor === 2999);
  check("convert identity rate_bps === 10000", ident.rate_bps === 10000);
  check("convert identity stale === false",  ident.stale === false);

  // Missing rate -- null + stale:true so the storefront can fall back.
  var miss = await fx.convert({ amount_minor: 2999, from: "USD", to: "EUR" });
  check("convert no-rate returns converted_minor:null", miss.converted_minor === null);
  check("convert no-rate returns rate_bps:null",         miss.rate_bps === null);
  check("convert no-rate stale:true",                    miss.stale === true);

  await fx.setRate({ base: "USD", quote: "EUR", rate: 0.92 });
  var got = await fx.convert({ amount_minor: 2999, from: "USD", to: "EUR" });
  // 2999 cents * 0.92 = 2759.08 -> banker's rounding to even -> 2759
  check("convert USD->EUR banker rounding", got.converted_minor === 2759);
  check("convert carries rate_bps",         got.rate_bps === 9200);
  check("convert stale:false on fresh row", got.stale === false);

  // Cross-exponent: USD (2 decimals) -> JPY (0 decimals).
  await fx.setRate({ base: "USD", quote: "JPY", rate: 155.5 });
  var jpy = await fx.convert({ amount_minor: 10000, from: "USD", to: "JPY" });
  // $100 * 155.5 = ¥15550 (yen are the minor unit themselves).
  check("convert USD->JPY zero-decimal target", jpy.converted_minor === 15550);

  // Expired rate -- the at-parameter lets the test pass a future
  // timestamp without waiting on the wall clock.
  var future = Date.now() + 100 * 24 * 60 * 60 * 1000;
  var exp = await fx.convert({ amount_minor: 1000, from: "USD", to: "EUR", at: future });
  check("convert expired-at-`at` returns null", exp.converted_minor === null);
  check("convert expired-at-`at` stale:true",   exp.stale === true);

  // Refusals.
  await assert.rejects(function () {
    return fx.convert({ amount_minor: 100, from: "USD", to: "ZZZ" });
  }, /supportedCurrencies/);
  await assert.rejects(function () {
    return fx.convert({ amount_minor: -1, from: "USD", to: "EUR" });
  }, /amount_minor/);
  await assert.rejects(function () {
    return fx.convert({ amount_minor: 1.5, from: "USD", to: "EUR" });
  }, /amount_minor/);
}

async function _format() {
  var fx = bShop.currencyDisplay.create({ query: _makeQuery() });

  // en-US baseline
  check("format USD en-US",
    fx.format({ amount_minor: 2999, currency: "USD", locale: "en-US" }) === "$29.99");
  check("format USD default locale is en-US",
    fx.format({ amount_minor: 2999, currency: "USD" }) === "$29.99");

  // de-DE -- comma decimal, space + suffix glyph.
  var deEur = fx.format({ amount_minor: 2759, currency: "EUR", locale: "de-DE" });
  check("format EUR de-DE has comma decimal", /27,59/.test(deEur));
  check("format EUR de-DE has euro glyph",     /€/.test(deEur));

  // ja-JP -- JPY is zero-decimal, glyph ¥ or "￥".
  var jaJpy = fx.format({ amount_minor: 15550, currency: "JPY", locale: "ja-JP" });
  check("format JPY ja-JP has no decimal separator", !/\./.test(jaJpy));
  check("format JPY ja-JP contains 15,550",          /15,550/.test(jaJpy));

  // Refusals.
  assert.throws(function () { fx.format({ amount_minor: -1, currency: "USD" }); }, /amount_minor/);
  assert.throws(function () { fx.format({ amount_minor: 100, currency: "usd" }); }, /ISO 4217/);
  assert.throws(function () { fx.format({ amount_minor: 100, currency: "USD", locale: "" }); }, /locale/);
}

async function _convertAndFormat() {
  var fx = bShop.currencyDisplay.create({ query: _makeQuery() });
  await fx.setRate({ base: "USD", quote: "EUR", rate: 0.92 });

  var out = await fx.convertAndFormat({
    amount_minor: 2999, from: "USD", to: "EUR", locale: "de-DE",
  });
  check("convertAndFormat converted_minor", out.converted_minor === 2759);
  check("convertAndFormat de-DE display",   /27,59/.test(out.display) && /€/.test(out.display));
  check("convertAndFormat rate_bps",        out.rate_bps === 9200);
  check("convertAndFormat stale:false",     out.stale === false);

  // Stale fallback -- no rate row for USD->GBP.
  var stale = await fx.convertAndFormat({
    amount_minor: 100, from: "USD", to: "GBP",
  });
  check("convertAndFormat stale display:null", stale.display === null);
  check("convertAndFormat stale rate_bps:null", stale.rate_bps === null);
  check("convertAndFormat stale stale:true",   stale.stale === true);
}

async function _cleanupExpired() {
  var q  = _makeQuery();
  var fx = bShop.currencyDisplay.create({ query: q });

  await fx.setRate({ base: "USD", quote: "EUR", rate: 0.92, ttlMs: 60000 });
  await fx.setRate({ base: "USD", quote: "GBP", rate: 0.79, ttlMs: 60000 });
  await fx.setRate({ base: "USD", quote: "JPY", rate: 155, ttlMs: 60000 });

  // Push two rows' expires_at into the past.
  await q("UPDATE fx_rates SET expires_at = ?1 WHERE quote_currency IN ('EUR', 'GBP')", [1]);

  var deleted = await fx.cleanupExpired();
  check("cleanupExpired returns deleted count", deleted === 2);

  var jpy = await fx.getRate("USD", "JPY");
  check("cleanupExpired preserves still-fresh row", jpy !== null && jpy.stale === false);
  var eur = await fx.getRate("USD", "EUR");
  check("cleanupExpired removes expired row", eur === null);

  // Explicit cutoff form.
  await fx.setRate({ base: "EUR", quote: "USD", rate: 1.08, ttlMs: 60000 });
  var noop = await fx.cleanupExpired(1);
  check("cleanupExpired with low cutoff prunes nothing", noop === 0);

  // Bad cutoff
  await assert.rejects(function () { return fx.cleanupExpired("nope"); }, /ts/);
}

async function _bulkSetRates() {
  var q  = _makeQuery();
  var fx = bShop.currencyDisplay.create({ query: q });

  // Atomicity: a bad row in the batch aborts the whole write.
  await assert.rejects(function () {
    return fx.bulkSetRates([
      { base: "USD", quote: "EUR", rate: 0.92, source: "ecb" },
      { base: "USD", quote: "ZZZ", rate: 1.0,  source: "ecb" },          // unsupported
    ]);
  }, /row\[1\]/);
  var leak = await fx.getRate("USD", "EUR");
  check("bulkSetRates is atomic -- partial writes refused", leak === null);

  // Happy path -- batch of four valid rows lands together.
  var r = await fx.bulkSetRates([
    { base: "USD", quote: "EUR", rate: 0.92, source: "ecb" },
    { base: "USD", quote: "GBP", rate: 0.79, source: "ecb" },
    { base: "USD", quote: "JPY", rate: 155.5, source: "ecb" },
    { base: "EUR", quote: "USD", rate: 1.08, source: "ecb" },
  ]);
  check("bulkSetRates written count", r.written === 4);

  check("bulkSetRates row 1 readable", (await fx.getRate("USD", "EUR")).rate_bps === 9200);
  check("bulkSetRates row 2 readable", (await fx.getRate("USD", "GBP")).rate_bps === 7900);
  check("bulkSetRates row 3 readable", (await fx.getRate("USD", "JPY")).rate_bps === 1555000);
  check("bulkSetRates row 4 readable", (await fx.getRate("EUR", "USD")).rate_bps === 10800);

  // Re-running with new rates upserts the same primary keys.
  await fx.bulkSetRates([
    { base: "USD", quote: "EUR", rate: 0.93, source: "ecb" },
  ]);
  check("bulkSetRates upserts on re-run", (await fx.getRate("USD", "EUR")).rate_bps === 9300);

  // Empty batch is a no-op.
  var empty = await fx.bulkSetRates([]);
  check("bulkSetRates empty array no-op", empty.written === 0);

  // Non-array refused.
  await assert.rejects(function () { return fx.bulkSetRates("nope"); }, /rows must be an array/);
}

async function _supportedCurrenciesConfig() {
  // Operator narrows the allow-list -- the primitive refuses
  // anything outside that explicit list.
  var fx = bShop.currencyDisplay.create({
    query:               _makeQuery(),
    supportedCurrencies: ["USD", "EUR"],
  });
  check("supportedCurrencies echoed", fx.supportedCurrencies.length === 2);

  await fx.setRate({ base: "USD", quote: "EUR", rate: 0.92 });
  await assert.rejects(function () {
    return fx.setRate({ base: "USD", quote: "GBP", rate: 0.79 });
  }, /supportedCurrencies/);
  await assert.rejects(function () {
    return fx.convert({ amount_minor: 100, from: "USD", to: "GBP" });
  }, /supportedCurrencies/);

  // create() validates the supportedCurrencies argument shape.
  assert.throws(function () {
    bShop.currencyDisplay.create({ query: _makeQuery(), supportedCurrencies: [] });
  }, /non-empty array/);
  assert.throws(function () {
    bShop.currencyDisplay.create({ query: _makeQuery(), supportedCurrencies: ["us"] });
  }, /ISO 4217/);

  // defaultTtlMs validation.
  assert.throws(function () {
    bShop.currencyDisplay.create({ query: _makeQuery(), defaultTtlMs: -1 });
  }, /defaultTtlMs/);
}

async function run() {
  await _setRate();
  await _getRate();
  await _convert();
  await _format();
  await _convertAndFormat();
  await _cleanupExpired();
  await _bulkSetRates();
  await _supportedCurrenciesConfig();
}

module.exports = { run: run };
