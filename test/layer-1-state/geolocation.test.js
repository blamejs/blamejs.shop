"use strict";
/**
 * geolocation — request-hint -> country/region/currency/locale/tz
 * resolver + operator-managed per-country settings.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0092.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/geolocation.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineCountry persists every column, dupe-define refused
 *   - resolve happy path (cf_country wins, region passthrough)
 *   - resolve picks accept-language tag that matches default's
 *     primary subtag (de-DE default + "de-AT,de;q=0.8,en;q=0.5" ->
 *     de-AT); no match falls back to the row default
 *   - customer_supplied_country override beats cf_country when the
 *     supplied code has a row; stale supplied value falls through
 *   - resolve returns null for a cf_country with no row
 *   - defineCountry refusals (bad code, bad currency, bad kinds,
 *     reason without blocked, dupe define)
 *   - setGeoBlock flips state, clears reason on unblock, refuses
 *     reason on unblock
 *   - geo_blocked propagates into resolve output
 *   - allowed_payment_kinds filter survives the round-trip
 *   - updateCountry patch surface (allowed columns + refusal of
 *     geo_blocked / code mutation attempts)
 *   - listCountries + blockedRoster + getCountry happy paths
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

require("../../lib");                                                       // ensure entry-point loads + the framework handle works for lazy require
var geolocation = require("../../lib/geolocation");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0092_geolocation.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PATH, "utf8")).forEach(function (s) {
    db.prepare(s).run();
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

function _setup() {
  var query = _makeQuery();
  var geo   = geolocation.create({ query: query });
  return { query: query, geo: geo };
}

async function _seedDE(geo) {
  return await geo.defineCountry({
    code:                   "DE",
    currency:               "EUR",
    default_locale:         "de-DE",
    geo_blocked:            false,
    allowed_payment_kinds:  ["card", "sepa_debit", "klarna"],
    allowed_shipping_kinds: ["standard", "express"],
    default_timezone:       "Europe/Berlin",
  });
}

async function _seedUS(geo) {
  return await geo.defineCountry({
    code:                   "US",
    currency:               "USD",
    default_locale:         "en-US",
    geo_blocked:            false,
    allowed_payment_kinds:  ["card", "applepay", "googlepay"],
    allowed_shipping_kinds: ["standard", "express", "overnight"],
    // Multi-tz country — no default_timezone.
  });
}

async function _defineHappyPath() {
  var ctx = _setup();
  var de  = await _seedDE(ctx.geo);
  check("defineCountry returns row",               de && typeof de === "object");
  check("defineCountry persists code",             de.code === "DE");
  check("defineCountry persists currency",         de.currency === "EUR");
  check("defineCountry persists default_locale",   de.default_locale === "de-DE");
  check("defineCountry geo_blocked false",         de.geo_blocked === false);
  check("defineCountry geo_block_reason null",     de.geo_block_reason === null);
  check("defineCountry payment kinds array",       Array.isArray(de.allowed_payment_kinds)
                                                   && de.allowed_payment_kinds.length === 3);
  check("defineCountry shipping kinds array",      Array.isArray(de.allowed_shipping_kinds)
                                                   && de.allowed_shipping_kinds.length === 2);
  check("defineCountry persists timezone",         de.default_timezone === "Europe/Berlin");
  check("defineCountry stamps created_at",         typeof de.created_at === "number");
  check("defineCountry stamps updated_at",         typeof de.updated_at === "number");

  // No default_timezone variant.
  var us = await _seedUS(ctx.geo);
  check("defineCountry null default_timezone ok",  us.default_timezone === null);

  // Dupe define refused.
  await assert.rejects(_seedDE(ctx.geo), /already exists/);
}

async function _resolveHappyPath() {
  var ctx = _setup();
  await _seedDE(ctx.geo);

  var r = await ctx.geo.resolve({
    cf_country:      "DE",
    cf_region:       "BE",
    accept_language: "de-DE,de;q=0.9,en;q=0.5",
    timezone:        "Europe/Berlin",
  });
  check("resolve returns object",                  r && typeof r === "object");
  check("resolve country from cf_country",         r.country === "DE");
  check("resolve region from cf_region",           r.region === "BE");
  check("resolve currency from row",               r.currency === "EUR");
  check("resolve locale from accept-language",     r.locale === "de-DE");
  check("resolve timezone passthrough",            r.timezone === "Europe/Berlin");
  check("resolve geo_blocked false",               r.geo_blocked === false);
  check("resolve payment kinds round-trip",        r.allowed_payment_kinds.indexOf("sepa_debit") !== -1);
  check("resolve shipping kinds round-trip",       r.allowed_shipping_kinds.indexOf("express")   !== -1);

  // Missing region: returned object has no `region` key.
  var noRegion = await ctx.geo.resolve({ cf_country: "DE" });
  check("resolve no cf_region -> no region key",   !Object.prototype.hasOwnProperty.call(noRegion, "region"));
  // Falls back to row default_timezone.
  check("resolve falls back to default_timezone",  noRegion.timezone === "Europe/Berlin");
}

async function _localePrimarySubtagMatch() {
  var ctx = _setup();
  await _seedDE(ctx.geo);

  // de-AT requested with q=0.8; de-DE is the row default; the
  // resolver prefers the request's de-AT because its primary subtag
  // matches the default's primary subtag.
  var r = await ctx.geo.resolve({
    cf_country:      "DE",
    accept_language: "fr-FR;q=0.5,de-AT;q=0.8,en;q=0.3",
  });
  check("locale: q-sorted primary-subtag match wins", r.locale === "de-AT");

  // No primary-subtag match -> row default wins.
  var r2 = await ctx.geo.resolve({
    cf_country:      "DE",
    accept_language: "fr-FR,en;q=0.5",
  });
  check("locale: no primary-subtag match -> row default", r2.locale === "de-DE");

  // Empty / malformed header -> row default.
  var r3 = await ctx.geo.resolve({
    cf_country:      "DE",
    accept_language: "",
  });
  check("locale: empty accept_language -> row default",   r3.locale === "de-DE");
}

async function _customerSuppliedOverride() {
  var ctx = _setup();
  await _seedDE(ctx.geo);
  await _seedUS(ctx.geo);

  // Buyer on a US IP explicitly picks DE in a country dropdown.
  var r = await ctx.geo.resolve({
    cf_country:                "US",
    cf_region:                 "CA",
    customer_supplied_country: "DE",
  });
  check("supplied DE beats cf US",                 r.country === "DE");
  check("supplied DE -> EUR currency",             r.currency === "EUR");
  check("supplied DE -> de-DE locale default",     r.locale === "de-DE");
  // cf_region discarded when supplied country doesn't match cf_country
  // — the region is meaningful only against the country it was
  // reported for.
  check("supplied override discards cf_region",    !Object.prototype.hasOwnProperty.call(r, "region"));

  // Stale supplied value (no row) falls through to cf_country.
  var r2 = await ctx.geo.resolve({
    cf_country:                "US",
    cf_region:                 "CA",
    customer_supplied_country: "ZZ",
  });
  check("stale supplied -> fall through to cf",    r2.country === "US");
  check("fall-through restores cf_region",         r2.region === "CA");
  check("US has no default_timezone -> no key",    !Object.prototype.hasOwnProperty.call(r2, "timezone"));

  // Unknown cf_country with no settings -> null (operator hasn't
  // declared the market yet).
  var r3 = await ctx.geo.resolve({ cf_country: "ZZ" });
  check("unknown cf_country -> null",              r3 === null);
}

async function _defineRefusals() {
  var ctx = _setup();

  // Bad country code shape.
  await assert.rejects(ctx.geo.defineCountry({
    code:                   "de",                                            // lowercase
    currency:               "EUR",
    default_locale:         "de-DE",
    geo_blocked:            false,
    allowed_payment_kinds:  ["card"],
    allowed_shipping_kinds: ["standard"],
  }), /code/);

  await assert.rejects(ctx.geo.defineCountry({
    code:                   "DEU",                                           // three-letter
    currency:               "EUR",
    default_locale:         "de-DE",
    geo_blocked:            false,
    allowed_payment_kinds:  ["card"],
    allowed_shipping_kinds: ["standard"],
  }), /code/);

  // Bad currency.
  await assert.rejects(ctx.geo.defineCountry({
    code:                   "DE",
    currency:               "euro",
    default_locale:         "de-DE",
    geo_blocked:            false,
    allowed_payment_kinds:  ["card"],
    allowed_shipping_kinds: ["standard"],
  }), /currency/);

  // Bad locale.
  await assert.rejects(ctx.geo.defineCountry({
    code:                   "DE",
    currency:               "EUR",
    default_locale:         "DE_de",                                         // underscore
    geo_blocked:            false,
    allowed_payment_kinds:  ["card"],
    allowed_shipping_kinds: ["standard"],
  }), /default_locale/);

  // Bad kind (uppercase / control byte / empty / dupe).
  await assert.rejects(ctx.geo.defineCountry({
    code:                   "DE",
    currency:               "EUR",
    default_locale:         "de-DE",
    geo_blocked:            false,
    allowed_payment_kinds:  ["Card"],                                        // uppercase
    allowed_shipping_kinds: ["standard"],
  }), /allowed_payment_kinds/);

  await assert.rejects(ctx.geo.defineCountry({
    code:                   "DE",
    currency:               "EUR",
    default_locale:         "de-DE",
    geo_blocked:            false,
    allowed_payment_kinds:  ["card", "card"],                                // dupe
    allowed_shipping_kinds: ["standard"],
  }), /duplicates/);

  // Non-array kinds.
  await assert.rejects(ctx.geo.defineCountry({
    code:                   "DE",
    currency:               "EUR",
    default_locale:         "de-DE",
    geo_blocked:            false,
    allowed_payment_kinds:  "card",
    allowed_shipping_kinds: ["standard"],
  }), /must be an array/);

  // reason without geo_blocked.
  await assert.rejects(ctx.geo.defineCountry({
    code:                   "DE",
    currency:               "EUR",
    default_locale:         "de-DE",
    geo_blocked:            false,
    geo_block_reason:       "sanctions",
    allowed_payment_kinds:  ["card"],
    allowed_shipping_kinds: ["standard"],
  }), /geo_blocked = true/);

  // Bad timezone.
  await assert.rejects(ctx.geo.defineCountry({
    code:                   "DE",
    currency:               "EUR",
    default_locale:         "de-DE",
    geo_blocked:            false,
    allowed_payment_kinds:  ["card"],
    allowed_shipping_kinds: ["standard"],
    default_timezone:       "berlin",
  }), /default_timezone/);

  // Empty/missing input.
  await assert.rejects(ctx.geo.defineCountry(null), /input object required/);
}

async function _setGeoBlockFlip() {
  var ctx = _setup();
  await _seedDE(ctx.geo);

  // Block it.
  var blocked = await ctx.geo.setGeoBlock({
    country_code: "DE",
    blocked:      true,
    reason:       "test sanctions",
  });
  check("setGeoBlock sets blocked=true",           blocked.geo_blocked === true);
  check("setGeoBlock persists reason",             blocked.geo_block_reason === "test sanctions");

  // Unblock — reason cleared.
  var unblocked = await ctx.geo.setGeoBlock({
    country_code: "DE",
    blocked:      false,
  });
  check("setGeoBlock clears blocked",              unblocked.geo_blocked === false);
  check("setGeoBlock clears reason on unblock",    unblocked.geo_block_reason === null);

  // Refuses reason+blocked=false.
  await assert.rejects(ctx.geo.setGeoBlock({
    country_code: "DE",
    blocked:      false,
    reason:       "stale text",
  }), /meaningless/);

  // Unknown country -> null.
  var noop = await ctx.geo.setGeoBlock({
    country_code: "ZZ",
    blocked:      true,
    reason:       "x",
  });
  check("setGeoBlock unknown -> null",             noop === null);

  // blockedRoster picks up the flip.
  await ctx.geo.setGeoBlock({ country_code: "DE", blocked: true, reason: "second" });
  await _seedUS(ctx.geo);
  var roster = await ctx.geo.blockedRoster();
  check("blockedRoster: length 1",                 roster.length === 1);
  check("blockedRoster: includes DE",              roster[0].code === "DE");
}

async function _geoBlockedPropagation() {
  var ctx = _setup();
  await _seedDE(ctx.geo);
  await ctx.geo.setGeoBlock({
    country_code: "DE",
    blocked:      true,
    reason:       "no shipping carrier coverage",
  });

  var r = await ctx.geo.resolve({ cf_country: "DE" });
  check("blocked country: resolve geo_blocked=true", r.geo_blocked === true);
  check("blocked country: country still resolves",   r.country === "DE");
  // Kinds still surface so the checkout can render an explanation
  // banner with the same data shape as the unblocked path.
  check("blocked country: kinds still returned",     Array.isArray(r.allowed_payment_kinds));
}

async function _allowedPaymentKindsFilter() {
  var ctx = _setup();
  await _seedDE(ctx.geo);
  await _seedUS(ctx.geo);

  var de = await ctx.geo.resolve({ cf_country: "DE" });
  var us = await ctx.geo.resolve({ cf_country: "US" });

  // Caller composes the filter: "render only the methods the
  // resolved country allows".
  var menu = ["card", "applepay", "sepa_debit", "klarna", "googlepay"];
  function _filter(methods, allowed) {
    return methods.filter(function (m) { return allowed.indexOf(m) !== -1; });
  }
  var deMenu = _filter(menu, de.allowed_payment_kinds);
  var usMenu = _filter(menu, us.allowed_payment_kinds);

  check("DE filter keeps sepa_debit",              deMenu.indexOf("sepa_debit") !== -1);
  check("DE filter keeps klarna",                  deMenu.indexOf("klarna") !== -1);
  check("DE filter drops applepay",                deMenu.indexOf("applepay") === -1);
  check("US filter keeps applepay",                usMenu.indexOf("applepay") !== -1);
  check("US filter drops sepa_debit",              usMenu.indexOf("sepa_debit") === -1);
  check("US filter drops klarna",                  usMenu.indexOf("klarna") === -1);
}

async function _updateCountryPatchSurface() {
  var ctx = _setup();
  await _seedDE(ctx.geo);

  // Allowed columns.
  var bumped = await ctx.geo.updateCountry("DE", {
    currency:              "EUR",
    default_locale:        "de-AT",
    allowed_payment_kinds: ["card", "sepa_debit", "klarna", "paypal"],
    default_timezone:      "Europe/Vienna",
  });
  check("updateCountry sets default_locale",       bumped.default_locale === "de-AT");
  check("updateCountry adds payment kind",         bumped.allowed_payment_kinds.indexOf("paypal") !== -1);
  check("updateCountry sets default_timezone",     bumped.default_timezone === "Europe/Vienna");

  // null default_timezone clears.
  var cleared = await ctx.geo.updateCountry("DE", { default_timezone: null });
  check("updateCountry clears default_timezone",   cleared.default_timezone === null);

  // Refuse geo_blocked through patch surface.
  await assert.rejects(ctx.geo.updateCountry("DE", { geo_blocked: true }), /not updatable/);
  // Refuse code mutation.
  await assert.rejects(ctx.geo.updateCountry("DE", { code: "AT" }), /not updatable/);
  // Refuse empty patch.
  await assert.rejects(ctx.geo.updateCountry("DE", {}), /at least one column/);

  // Unknown country -> null.
  var noop = await ctx.geo.updateCountry("ZZ", { currency: "USD" });
  check("updateCountry unknown -> null",           noop === null);
}

async function _listAndGet() {
  var ctx = _setup();
  await _seedDE(ctx.geo);
  await _seedUS(ctx.geo);
  await ctx.geo.setGeoBlock({ country_code: "US", blocked: true, reason: "test" });

  var all = await ctx.geo.listCountries();
  check("listCountries returns both",              all.length === 2);
  check("listCountries sorted by code",            all[0].code === "DE" && all[1].code === "US");

  var blocked = await ctx.geo.listCountries({ geo_blocked: true });
  check("listCountries filtered: blocked length",  blocked.length === 1);
  check("listCountries filtered: blocked code",    blocked[0].code === "US");

  var live = await ctx.geo.listCountries({ geo_blocked: false });
  check("listCountries filtered: live length",     live.length === 1);
  check("listCountries filtered: live code",       live[0].code === "DE");

  var got = await ctx.geo.getCountry("DE");
  check("getCountry returns DE",                   got && got.code === "DE");
  var miss = await ctx.geo.getCountry("ZZ");
  check("getCountry unknown -> null",              miss === null);

  // Bad code shape on read APIs throws.
  await assert.rejects(ctx.geo.getCountry("de"), /code/);
}

async function run() {
  await _defineHappyPath();
  await _resolveHappyPath();
  await _localePrimarySubtagMatch();
  await _customerSuppliedOverride();
  await _defineRefusals();
  await _setGeoBlockFlip();
  await _geoBlockedPropagation();
  await _allowedPaymentKindsFilter();
  await _updateCountryPatchSurface();
  await _listAndGet();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/geolocation.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - geolocation (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
