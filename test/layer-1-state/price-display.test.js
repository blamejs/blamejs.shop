"use strict";
/**
 * price-display — per-country presentation mode + per-customer override
 * resolution against the migration 0097 schema.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0097
 * (price_display_rules + customer_price_display_overrides).
 *
 * Coverage:
 *   - defineRule: happy path for a per-country mode (DE → tax_included)
 *     plus refusals on bad mode enum / re-define / bad country shape
 *   - getModeFor precedence:
 *       customer-override (B2B) > customer_status > country default,
 *     including the EU customer-override-wins-over-country-default case
 *   - formatPrice with tax breakdown: stubbed `tax` adapter composes to
 *     `{ net, tax, gross }` for the DE rule at 19% VAT, both inclusive
 *     and exclusive branches
 *   - listRules / updateRule / archiveRule (idempotent re-archive)
 *   - defineCustomerOverride / clearCustomerOverride round trip and
 *     upsert-in-place behaviour
 *   - getModeFor uses customer_status when the country rule's
 *     customer_status_in filter matches
 *   - validation: every entry point refuses bad input shape; factory
 *     refuses tax / geolocation handles missing required surface
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var priceDisplay = require("../../lib/price-display");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG_PD = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0097_price_display.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PD, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
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
    },
  };
}

// Stub the `tax` primitive's two methods used by formatPrice. We do
// NOT depend on lib/tax.js here so the unit isolates price-display
// resolution from tax-math correctness.
function _stubTax() {
  return {
    calls: [],
    handle: {
      calculateInclusive: function (args) {
        // gross known, derive net + tax via banker's rounding
        // (mirrors lib/tax behaviour without requiring it).
        var gross = args.amount_minor;
        var rate  = args.rate_bps;
        var raw   = gross * rate / (10000 + rate);
        var tax   = Math.round(raw);
        // banker's-round tie correction
        if (Math.abs(raw - Math.floor(raw) - 0.5) < 1e-9 && (Math.floor(raw) % 2) === 0) tax = Math.floor(raw);
        return {
          net_minor:   gross - tax,
          tax_minor:   tax,
          gross_minor: gross,
          rate_bps:    rate,
        };
      },
      calculateExclusive: function (args) {
        var net  = args.amount_minor;
        var rate = args.rate_bps;
        var raw  = net * rate / 10000;
        var tax  = Math.round(raw);
        if (Math.abs(raw - Math.floor(raw) - 0.5) < 1e-9 && (Math.floor(raw) % 2) === 0) tax = Math.floor(raw);
        return {
          net_minor:   net,
          tax_minor:   tax,
          gross_minor: net + tax,
          rate_bps:    rate,
        };
      },
    },
  };
}

function _factory(opts) {
  opts = opts || {};
  var h = _makeQuery();
  var createOpts = { query: h.query };
  if (opts.tax)         createOpts.tax         = opts.tax;
  if (opts.taxRates)    createOpts.taxRates    = opts.taxRates;
  if (opts.geolocation) createOpts.geolocation = opts.geolocation;
  return {
    db:    h.db,
    query: h.query,
    pd:    priceDisplay.create(createOpts),
  };
}

// ---- defineRule ----------------------------------------------------------

async function _defineRuleHappyAndBadEnum() {
  var f = _factory();
  var rule = await f.pd.defineRule({ country: "DE", mode: "tax_included" });
  check("defineRule DE returns row",         rule != null);
  check("defineRule DE mode persisted",      rule.mode === "tax_included");
  check("defineRule DE country persisted",   rule.country === "DE");
  check("defineRule no status filter",       rule.customer_status_in === null);
  check("defineRule not archived",           rule.archived_at === null);
  check("defineRule created_at set",         typeof rule.created_at === "number" && rule.created_at > 0);
  check("defineRule created == updated",     rule.created_at === rule.updated_at);

  // Bad enum value refused.
  await assert.rejects(
    f.pd.defineRule({ country: "FR", mode: "vat-included" }),
    /mode must be one of/,
  );
  await assert.rejects(
    f.pd.defineRule({ country: "FR", mode: "" }),
    /mode must be one of/,
  );

  // Bad country shape refused.
  await assert.rejects(
    f.pd.defineRule({ country: "deu", mode: "tax_included" }),
    /country must be a 2-letter uppercase ISO 3166-1/,
  );
  await assert.rejects(
    f.pd.defineRule({ country: "de", mode: "tax_included" }),
    /country must be a 2-letter uppercase ISO 3166-1/,
  );

  // Re-define against an existing country refused (operators use
  // updateRule for in-place mutation).
  await assert.rejects(
    f.pd.defineRule({ country: "DE", mode: "tax_excluded" }),
    /already has a rule — use updateRule/,
  );

  // Status filter persists when provided.
  var b2b = await f.pd.defineRule({
    country: "FR", mode: "tax_excluded", customer_status_in: ["b2b", "wholesale"],
  });
  check("defineRule status_in persisted",    Array.isArray(b2b.customer_status_in) && b2b.customer_status_in.length === 2);
  check("defineRule status_in dedupe-safe",  b2b.customer_status_in.indexOf("b2b") !== -1
                                              && b2b.customer_status_in.indexOf("wholesale") !== -1);

  // Empty array becomes null (no filter — country default).
  var empty = await f.pd.defineRule({
    country: "IT", mode: "tax_included", customer_status_in: [],
  });
  check("defineRule empty status_in → null", empty.customer_status_in === null);
}

// ---- getModeFor precedence ----------------------------------------------

async function _getModeForPrecedence() {
  var f = _factory();
  // Country defaults: DE = tax_included (EU B2C), US = tax_excluded.
  await f.pd.defineRule({ country: "DE", mode: "tax_included" });
  await f.pd.defineRule({ country: "US", mode: "tax_excluded" });

  // Country default applies when no override + no status filter.
  var deDefault = await f.pd.getModeFor({ country: "DE" });
  check("DE default tax_included",           deDefault.mode === "tax_included");
  check("DE source country_default",         deDefault.source === "country_default");

  var usDefault = await f.pd.getModeFor({ country: "US" });
  check("US default tax_excluded",           usDefault.mode === "tax_excluded");
  check("US source country_default",         usDefault.source === "country_default");

  // Unknown country yields null mode + null source.
  var unknown = await f.pd.getModeFor({ country: "ZW" });
  check("unknown country mode null",         unknown.mode === null);
  check("unknown country source null",       unknown.source === null);

  // Customer override always wins over country default.
  var custId = "cus_b2b_42";
  await f.pd.defineCustomerOverride({ customer_id: custId, mode: "tax_excluded" });

  var withOverride = await f.pd.getModeFor({ country: "DE", customer_id: custId });
  check("override beats country default",    withOverride.mode === "tax_excluded");
  check("override source customer_override", withOverride.source === "customer_override");

  // Customer-status narrowed rule wins over country default when status matches.
  await f.pd.defineRule({ country: "GB", mode: "tax_excluded", customer_status_in: ["b2b"] });
  var gbB2B = await f.pd.getModeFor({ country: "GB", customer_status: "b2b" });
  check("GB b2b status_in resolves",         gbB2B.mode === "tax_excluded");
  check("GB b2b source customer_status",     gbB2B.source === "customer_status");

  // Same GB rule, mismatched status → no rule applies (status-narrowed
  // rule rejects non-matching status).
  var gbB2C = await f.pd.getModeFor({ country: "GB", customer_status: "b2c" });
  check("GB b2c no match → null",            gbB2C.mode === null && gbB2C.source === null);

  // Archived rule never applies.
  await f.pd.archiveRule("DE");
  var deArchived = await f.pd.getModeFor({ country: "DE" });
  check("archived DE mode null",             deArchived.mode === null && deArchived.source === null);

  // But customer override still wins for that same customer even when
  // the country rule has been archived.
  var ovStillWins = await f.pd.getModeFor({ country: "DE", customer_id: custId });
  check("override survives archive",         ovStillWins.mode === "tax_excluded" && ovStillWins.source === "customer_override");
}

// ---- formatPrice with tax breakdown -------------------------------------

async function _formatPriceWithTaxBreakdown() {
  var stub = _stubTax();
  var f = _factory({
    tax:      stub.handle,
    taxRates: { DE: 1900, US: 0, JP: 1000 },
  });
  await f.pd.defineRule({ country: "DE", mode: "tax_included" });
  await f.pd.defineRule({ country: "US", mode: "tax_excluded" });

  // DE, tax_included: gross = 12000 minor (€120.00), VAT 19%.
  //   tax   = round(12000*1900/11900) = 1916
  //   net   = 12000 - 1916           = 10084
  var de = await f.pd.formatPrice({
    amount_minor:    12000,
    currency:        "EUR",
    country:         "DE",
    customer_status: "b2c",
    locale:          "de-DE",
  });
  check("DE formatPrice display_minor",       de.display_minor === 12000);
  check("DE formatPrice mode tax_included",   de.mode === "tax_included");
  check("DE formatPrice source country",      de.source === "country_default");
  check("DE formatPrice tax_breakdown gross", de.tax_breakdown && de.tax_breakdown.gross === 12000);
  check("DE formatPrice tax_breakdown tax",   de.tax_breakdown.tax === 1916);
  check("DE formatPrice tax_breakdown net",   de.tax_breakdown.net === 10084);
  check("DE formatPrice display_label set",   typeof de.display_label === "string" && de.display_label.length > 0);

  // US, tax_excluded: net = 1000 minor ($10.00), rate 0 → tax 0, gross 1000.
  var us = await f.pd.formatPrice({
    amount_minor: 1000,
    currency:     "USD",
    country:      "US",
    locale:       "en-US",
  });
  check("US formatPrice mode tax_excluded",   us.mode === "tax_excluded");
  check("US formatPrice net = stored",        us.tax_breakdown.net === 1000);
  check("US formatPrice tax = 0",             us.tax_breakdown.tax === 0);
  check("US formatPrice gross = net",         us.tax_breakdown.gross === 1000);

  // No tax-rate for the country in the map → label-only, no breakdown.
  await f.pd.defineRule({ country: "FR", mode: "tax_included" });
  var fr = await f.pd.formatPrice({
    amount_minor: 5000,
    currency:     "EUR",
    country:      "FR",
    locale:       "fr-FR",
  });
  check("FR no rate → no breakdown",          fr.tax_breakdown === undefined);
  check("FR still renders label",             typeof fr.display_label === "string" && fr.display_label.length > 0);
  check("FR carries resolved mode",           fr.mode === "tax_included");

  // No rule at all → mode null, label still rendered.
  var none = await f.pd.formatPrice({
    amount_minor: 7777,
    currency:     "JPY",
    country:      "JP",  // rate present but no rule
    locale:       "ja-JP",
  });
  check("JP no rule → mode null",             none.mode === null);
  check("JP no rule → no breakdown",          none.tax_breakdown === undefined);
  check("JP no rule still has label",         typeof none.display_label === "string" && none.display_label.length > 0);
}

// ---- B2B customer override beats EU tax_included default ----------------

async function _b2bOverrideBeatsEUDefault() {
  var stub = _stubTax();
  var f = _factory({
    tax:      stub.handle,
    taxRates: { DE: 1900 },
  });
  await f.pd.defineRule({ country: "DE", mode: "tax_included" });

  var b2bCust = "cus_b2b_acme.gmbh";
  await f.pd.defineCustomerOverride({ customer_id: b2bCust, mode: "tax_excluded" });

  // Net-stored 10000 minor presented to a B2B buyer in DE — override
  // pins tax_excluded, so calculateExclusive runs (tax = 1900, gross = 11900).
  var out = await f.pd.formatPrice({
    amount_minor: 10000,
    currency:     "EUR",
    country:      "DE",
    customer_id:  b2bCust,
    locale:       "de-DE",
  });
  check("B2B mode tax_excluded",              out.mode === "tax_excluded");
  check("B2B source customer_override",       out.source === "customer_override");
  check("B2B net = stored 10000",             out.tax_breakdown.net === 10000);
  check("B2B tax = 1900",                     out.tax_breakdown.tax === 1900);
  check("B2B gross = 11900",                  out.tax_breakdown.gross === 11900);

  // Same buyer, no override → reverts to country default tax_included.
  await f.pd.clearCustomerOverride(b2bCust);
  var b2c = await f.pd.formatPrice({
    amount_minor: 11900,
    currency:     "EUR",
    country:      "DE",
    customer_id:  b2bCust,
    locale:       "de-DE",
  });
  check("after clear → country default",      b2c.mode === "tax_included" && b2c.source === "country_default");
  check("after clear → inclusive math",       b2c.tax_breakdown.gross === 11900);
}

// ---- listRules / updateRule / archiveRule -------------------------------

async function _listUpdateArchiveRoundTrip() {
  var f = _factory();
  await f.pd.defineRule({ country: "DE", mode: "tax_included" });
  await f.pd.defineRule({ country: "FR", mode: "tax_included" });
  await f.pd.defineRule({ country: "US", mode: "tax_excluded" });
  await f.pd.defineRule({ country: "GB", mode: "tax_excluded", customer_status_in: ["b2b"] });

  // listRules: live-only by default, ordered by country ascending.
  var live = await f.pd.listRules();
  check("listRules returns array",            Array.isArray(live));
  check("listRules count 4",                  live.length === 4);
  check("listRules ordered DE,FR,GB,US",      live[0].country === "DE"
                                                && live[1].country === "FR"
                                                && live[2].country === "GB"
                                                && live[3].country === "US");

  // updateRule: flip FR to `both` and replace its (absent) status filter.
  var updatedFr = await f.pd.updateRule({
    country: "FR",
    patch:   { mode: "both", customer_status_in: ["b2c"] },
  });
  check("update FR mode",                     updatedFr.mode === "both");
  check("update FR status_in",                Array.isArray(updatedFr.customer_status_in)
                                                && updatedFr.customer_status_in[0] === "b2c");
  check("update FR updated_at advanced",      updatedFr.updated_at >= updatedFr.created_at);

  // updateRule on a non-existent country refuses.
  await assert.rejects(
    f.pd.updateRule({ country: "ZW", patch: { mode: "tax_excluded" } }),
    /has no rule/,
  );

  // updateRule rejects unsupported columns.
  await assert.rejects(
    f.pd.updateRule({ country: "FR", patch: { country: "ZZ" } }),
    /unsupported column/,
  );
  await assert.rejects(
    f.pd.updateRule({ country: "FR", patch: {} }),
    /at least one column/,
  );

  // archiveRule soft-deletes; getRule still returns the row with
  // archived_at populated; listRules() omits it; include_archived=true
  // brings it back.
  var archived = await f.pd.archiveRule("US");
  check("archiveRule sets archived_at",       archived.archived_at != null && typeof archived.archived_at === "number");

  var afterArchive = await f.pd.listRules();
  check("listRules excludes archived",        afterArchive.length === 3
                                                && afterArchive.every(function (r) { return r.country !== "US"; }));

  var withArchived = await f.pd.listRules({ include_archived: true });
  check("include_archived returns 4",         withArchived.length === 4);

  // Idempotent re-archive: returns the existing archived row.
  var reArchive = await f.pd.archiveRule("US");
  check("archive idempotent",                 reArchive.archived_at === archived.archived_at);

  // archiveRule on unknown country refuses.
  await assert.rejects(
    f.pd.archiveRule("ZW"),
    /not found/,
  );

  // listRules limit validation.
  await assert.rejects(
    f.pd.listRules({ limit: 0 }),
    /limit must be an integer/,
  );
  await assert.rejects(
    f.pd.listRules({ limit: 1000 }),
    /limit must be an integer/,
  );
  await assert.rejects(
    f.pd.listRules({ include_archived: "yes" }),
    /include_archived must be a boolean/,
  );
}

// ---- defineCustomerOverride / clearCustomerOverride round trip ----------

async function _customerOverrideRoundTrip() {
  var f = _factory();
  var custId = "cus_round.trip_01";

  // No override initially.
  var before = await f.pd.customerOverride(custId);
  check("no override returns null",           before === null);

  // Set one.
  var ov1 = await f.pd.defineCustomerOverride({ customer_id: custId, mode: "tax_excluded" });
  check("override set returns row",           ov1 != null && ov1.mode === "tax_excluded");
  check("override customer_id echoed",        ov1.customer_id === custId);
  check("override set_at is integer",         typeof ov1.set_at === "number" && ov1.set_at > 0);

  // Read it back.
  var read = await f.pd.customerOverride(custId);
  check("override readback matches",          read != null && read.mode === "tax_excluded");

  // Upsert in place — re-define with a new mode overwrites without
  // requiring an explicit clear.
  var ov2 = await f.pd.defineCustomerOverride({ customer_id: custId, mode: "both" });
  check("override upsert flips mode",         ov2.mode === "both");
  check("override upsert bumps set_at",       ov2.set_at >= ov1.set_at);

  // Confirm a single row exists.
  var rowCount = f.db.prepare(
    "SELECT COUNT(*) AS c FROM customer_price_display_overrides WHERE customer_id = ?"
  ).all(custId)[0].c;
  check("upsert → single row",                Number(rowCount) === 1);

  // Clear via object form.
  var cleared = await f.pd.clearCustomerOverride({ customer_id: custId });
  check("clear via object reports true",      cleared.cleared === true && cleared.customer_id === custId);

  var afterClear = await f.pd.customerOverride(custId);
  check("after clear → null",                 afterClear === null);

  // Clear on a missing customer reports cleared: false (idempotent).
  var clearedTwice = await f.pd.clearCustomerOverride(custId);
  check("re-clear cleared:false",             clearedTwice.cleared === false);

  // Clear via string form supported too.
  await f.pd.defineCustomerOverride({ customer_id: custId, mode: "tax_included" });
  var clearedStr = await f.pd.clearCustomerOverride(custId);
  check("clear via string supported",         clearedStr.cleared === true);
}

// ---- factory + entry-point validation refusals --------------------------

async function _factoryAndValidationRefusals() {
  // Factory refuses a tax handle missing one of the required methods.
  assert.throws(function () {
    priceDisplay.create({
      query: function () { return { rows: [], rowCount: 0 }; },
      tax:   { calculateInclusive: function () {} },   // missing calculateExclusive
    });
  }, /calculateInclusive \+ calculateExclusive/);

  assert.throws(function () {
    priceDisplay.create({
      query: function () { return { rows: [], rowCount: 0 }; },
      tax:   "not-an-object",
    });
  }, /tax must be an object handle/);

  // geolocation must be an object when present.
  assert.throws(function () {
    priceDisplay.create({
      query:       function () { return { rows: [], rowCount: 0 }; },
      geolocation: 42,
    });
  }, /geolocation must be an object handle/);

  var f = _factory();
  await f.pd.defineRule({ country: "DE", mode: "tax_included" });

  // defineRule shape refusals.
  await assert.rejects(f.pd.defineRule(),                                                  /input object required/);
  await assert.rejects(f.pd.defineRule({}),                                                /country/);
  await assert.rejects(f.pd.defineRule({ country: "DE" }),                                 /mode/);
  await assert.rejects(
    f.pd.defineRule({ country: "FR", mode: "tax_included", customer_status_in: "b2b" }),
    /customer_status_in must be an array/,
  );
  await assert.rejects(
    f.pd.defineRule({ country: "FR", mode: "tax_included", customer_status_in: ["BAD STATUS"] }),
    /customer_status_in\[0\]/,
  );

  // getModeFor shape refusals.
  await assert.rejects(f.pd.getModeFor(),                                                  /input object required/);
  await assert.rejects(f.pd.getModeFor({}),                                                /country/);
  await assert.rejects(f.pd.getModeFor({ country: "DE", customer_status: "BAD STATUS" }),  /customer_status/);
  await assert.rejects(f.pd.getModeFor({ country: "DE", customer_id: "bad id\nshape" }),   /customer_id/);

  // formatPrice shape refusals.
  await assert.rejects(f.pd.formatPrice(),                                                 /input object required/);
  await assert.rejects(f.pd.formatPrice({ currency: "EUR", country: "DE" }),               /amount_minor/);
  await assert.rejects(f.pd.formatPrice({ amount_minor: -1, currency: "EUR", country: "DE" }), /amount_minor/);
  await assert.rejects(f.pd.formatPrice({ amount_minor: 1.5, currency: "EUR", country: "DE" }), /amount_minor/);
  await assert.rejects(f.pd.formatPrice({ amount_minor: 100, country: "DE" }),             /currency/);
  await assert.rejects(f.pd.formatPrice({ amount_minor: 100, currency: "eur", country: "DE" }), /currency/);
  await assert.rejects(f.pd.formatPrice({ amount_minor: 100, currency: "EUR" }),           /country/);
  await assert.rejects(
    f.pd.formatPrice({ amount_minor: 100, currency: "EUR", country: "DE", locale: "" }),
    /locale must be a non-empty/,
  );

  // defineCustomerOverride shape refusals.
  await assert.rejects(f.pd.defineCustomerOverride(),                                       /input object required/);
  await assert.rejects(f.pd.defineCustomerOverride({ mode: "tax_excluded" }),               /customer_id/);
  await assert.rejects(f.pd.defineCustomerOverride({ customer_id: "ok" }),                  /mode/);
  await assert.rejects(
    f.pd.defineCustomerOverride({ customer_id: "ok", mode: "totally-wrong" }),
    /mode must be one of/,
  );
  await assert.rejects(f.pd.defineCustomerOverride({ customer_id: "bad\nid", mode: "both" }), /customer_id/);

  // clearCustomerOverride shape refusals.
  await assert.rejects(f.pd.clearCustomerOverride(),                                        /customer_id/);
  await assert.rejects(f.pd.clearCustomerOverride(42),                                      /customer_id/);
  await assert.rejects(f.pd.clearCustomerOverride({}),                                      /customer_id/);

  // archiveRule shape refusals.
  await assert.rejects(f.pd.archiveRule(),                                                  /country/);
  await assert.rejects(f.pd.archiveRule("zz"),                                              /country/);
}

// ---- exports ------------------------------------------------------------

async function _exportedSurface() {
  check("MODES exported on module",          Array.isArray(priceDisplay.MODES)
                                              && priceDisplay.MODES.indexOf("tax_included") !== -1
                                              && priceDisplay.MODES.indexOf("tax_excluded") !== -1
                                              && priceDisplay.MODES.indexOf("both")         !== -1);
  check("create function exported",          typeof priceDisplay.create === "function");

  // Each call to create() hands the operator a fresh MODES copy so a
  // caller that pushes/mutates the array can't poison sibling instances.
  var inst1 = priceDisplay.create({ query: _makeQuery().query });
  var inst2 = priceDisplay.create({ query: _makeQuery().query });
  check("instance exposes MODES",            Array.isArray(inst1.MODES) && inst1.MODES.length === 3);
  inst1.MODES.push("zzz");
  check("instance MODES isolated",           inst2.MODES.indexOf("zzz") === -1 && inst2.MODES.length === 3);
  var inst = inst2;
  check("instance exposes defineRule",       typeof inst.defineRule === "function");
  check("instance exposes formatPrice",      typeof inst.formatPrice === "function");
  check("instance exposes getModeFor",       typeof inst.getModeFor === "function");

  // bShop is referenced so the framework boot succeeds — surfaces
  // any wiring bug in the require chain when the test runs.
  check("bShop framework reachable",         bShop && bShop.framework && typeof bShop.framework.money === "object");
}

async function run() {
  await _defineRuleHappyAndBadEnum();
  await _getModeForPrecedence();
  await _formatPriceWithTaxBreakdown();
  await _b2bOverrideBeatsEUDefault();
  await _listUpdateArchiveRoundTrip();
  await _customerOverrideRoundTrip();
  await _factoryAndValidationRefusals();
  await _exportedSurface();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - price-display (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
