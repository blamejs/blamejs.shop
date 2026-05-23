"use strict";
/**
 * currency-rounding — per-currency display rounding rules + audit
 * trail against the migration 0132 schema.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0132
 * (currency_rounding_rules + currency_rounding_log).
 *
 * Coverage:
 *   - defineRule: happy path per currency (CHF / SEK / JPY) plus
 *     refusals on bad mode enum / bad applies_to / re-define-active /
 *     unknown ISO 4217 code
 *   - roundFor: each mode applied at the half-step boundary so
 *     half_up vs half_even diverge on the tie
 *   - CHF nearest-0.05 math against real-world prices (1287 -> 1285,
 *     1288 -> 1290, 1250 -> 1250)
 *   - SEK nearest-0.10 rounding
 *   - JPY whole-100-yen step (increment 100)
 *   - applies_to filtering: a `cart_total` rule does not affect a
 *     `line_total` roundFor request
 *   - historyForCurrency: log captures every applied rounding with
 *     adjustment delta + occurred_at window filter
 *   - updateRule / archiveRule round trip, idempotent re-archive,
 *     re-define-after-archive
 *   - validation: every entry point refuses bad input shape
 *   - exported constants (MODES / APPLIES_TO / round)
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var currencyRounding = require("../../lib/currency-rounding");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0132_currency_rounding.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
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

function _factory() {
  var h = _makeQuery();
  return {
    db:       h.db,
    query:    h.query,
    rounding: currencyRounding.create({ query: h.query }),
  };
}

// ---- the seven-plus test functions -------------------------------------

async function _defineRulePerCurrency() {
  var f = _factory();

  // CHF — nearest 0.05, half_up, cart_total. Switzerland's classic
  // Rappenrundung.
  var chf = await f.rounding.defineRule({
    currency:        "CHF",
    increment_minor: 5,
    mode:            "half_up",
    applies_to:      "cart_total",
  });
  check("defineRule CHF returns shape",     chf.currency === "CHF"
                                              && chf.increment_minor === 5
                                              && chf.mode === "half_up"
                                              && chf.applies_to === "cart_total"
                                              && chf.active === true
                                              && chf.archived_at === null);
  check("defineRule CHF created_at",        typeof chf.created_at === "number" && chf.created_at > 0);
  check("defineRule CHF updated_at",        typeof chf.updated_at === "number" && chf.updated_at >= chf.created_at);

  // SEK — nearest 0.10.
  var sek = await f.rounding.defineRule({
    currency:        "SEK",
    increment_minor: 10,
    mode:            "half_up",
    applies_to:      "cart_total",
  });
  check("defineRule SEK shape",             sek.currency === "SEK" && sek.increment_minor === 10);

  // JPY — 100-yen step (JPY has no minor unit so increment=100 is
  // 100 yen).
  var jpy = await f.rounding.defineRule({
    currency:        "JPY",
    increment_minor: 100,
    mode:            "floor",
    applies_to:      "all",
  });
  check("defineRule JPY shape",             jpy.currency === "JPY"
                                              && jpy.increment_minor === 100
                                              && jpy.mode === "floor");

  // listRules sorted by currency.
  var listed = await f.rounding.listRules({});
  check("listRules count",                  listed.length === 3);
  check("listRules order",                  listed[0].currency === "CHF"
                                              && listed[1].currency === "JPY"
                                              && listed[2].currency === "SEK");

  // getRule round trip.
  var roundTrip = await f.rounding.getRule("CHF");
  check("getRule round trip",               roundTrip.currency === "CHF" && roundTrip.increment_minor === 5);

  // Re-define against an active rule refuses.
  await assert.rejects(
    f.rounding.defineRule({
      currency: "CHF", increment_minor: 10, mode: "half_up", applies_to: "all",
    }),
    /already active/
  );

  // Unknown ISO 4217 code refuses.
  await assert.rejects(
    f.rounding.defineRule({
      currency: "ZZZ", increment_minor: 1, mode: "half_up", applies_to: "all",
    }),
    /ISO 4217/
  );

  // Bad mode enum refuses.
  await assert.rejects(
    f.rounding.defineRule({
      currency: "EUR", increment_minor: 1, mode: "weird", applies_to: "all",
    }),
    /mode/
  );

  // Bad applies_to refuses.
  await assert.rejects(
    f.rounding.defineRule({
      currency: "EUR", increment_minor: 1, mode: "half_up", applies_to: "weird",
    }),
    /applies_to/
  );
}

async function _roundForModeEnumeration() {
  // Test the pure rounding math directly against every mode at the
  // half-step boundary so half_up vs half_even diverge visibly.
  var _round = currencyRounding.round;

  // step = 10. Amount 25 sits exactly on the half-step between 20 and 30.
  check("half_up @ tie -> upper",        _round(25, 10, "half_up")   === 30);
  check("half_down @ tie -> lower",      _round(25, 10, "half_down") === 20);
  check("half_even @ tie 25 -> 20",      _round(25, 10, "half_even") === 20);   // 20 is even multiple
  check("half_even @ tie 35 -> 40",      _round(35, 10, "half_even") === 40);   // 40 is even multiple
  check("ceiling @ tie -> upper",        _round(25, 10, "ceiling")   === 30);
  check("floor @ tie -> lower",          _round(25, 10, "floor")     === 20);

  // Off the tie — every half-mode collapses to nearest.
  check("half_up below half",            _round(24, 10, "half_up")   === 20);
  check("half_up above half",            _round(26, 10, "half_up")   === 30);
  check("half_even below half",          _round(24, 10, "half_even") === 20);
  check("half_even above half",          _round(26, 10, "half_even") === 30);

  // step = 1 (identity) — every mode returns the input unchanged.
  check("step=1 identity half_up",       _round(7, 1, "half_up")    === 7);
  check("step=1 identity ceiling",       _round(7, 1, "ceiling")    === 7);

  // Negative amounts — half_up rounds AWAY from zero (the standard
  // arithmetic interpretation), so -25 -> -30.
  check("half_up neg tie -> away zero",  _round(-25, 10, "half_up")   === -30);
  check("half_down neg tie -> toward 0", _round(-25, 10, "half_down") === -20);
  check("floor negative",                _round(-23, 10, "floor")     === -30);
  check("ceiling negative",              _round(-23, 10, "ceiling")   === -20);
}

async function _chfRappenrundungMath() {
  var f = _factory();
  await f.rounding.defineRule({
    currency:        "CHF",
    increment_minor: 5,
    mode:            "half_up",
    applies_to:      "cart_total",
  });

  // 12.87 CHF -> 12.85 (down — closer to 12.85 than 12.90).
  var r1 = await f.rounding.roundFor({ amount_minor: 1287, currency: "CHF", kind: "cart_total" });
  check("CHF 12.87 -> 12.85",            r1.original_minor === 1287 && r1.rounded_minor === 1285 && r1.adjustment_minor === -2);

  // 12.88 CHF -> 12.90 (up — closer to 12.90).
  var r2 = await f.rounding.roundFor({ amount_minor: 1288, currency: "CHF", kind: "cart_total" });
  check("CHF 12.88 -> 12.90",            r2.rounded_minor === 1290 && r2.adjustment_minor === 2);

  // 12.50 CHF -> 12.50 (already on the increment, no-op).
  var r3 = await f.rounding.roundFor({ amount_minor: 1250, currency: "CHF", kind: "cart_total" });
  check("CHF 12.50 -> 12.50 no-op",      r3.rounded_minor === 1250 && r3.adjustment_minor === 0);

  // 12.825 CHF (1282.5 — but minor is integer) -> nearest 5: 12.83
  // doesn't exist; the smallest integer minor below 1285 with tie is
  // 1282 (-> 1280) and 1283 (-> 1285). Test the tie at 1282.5
  // surrogate via 1282 (rem=2 -> lower) and 1283 (rem=3 -> upper).
  var rA = await f.rounding.roundFor({ amount_minor: 1282, currency: "CHF", kind: "cart_total" });
  check("CHF 12.82 -> 12.80",            rA.rounded_minor === 1280);
  var rB = await f.rounding.roundFor({ amount_minor: 1283, currency: "CHF", kind: "cart_total" });
  check("CHF 12.83 -> 12.85",            rB.rounded_minor === 1285);
}

async function _jpyHundredYenStep() {
  var f = _factory();
  await f.rounding.defineRule({
    currency:        "JPY",
    increment_minor: 100,
    mode:            "half_up",
    applies_to:      "cart_total",
  });

  // 1234 yen -> 1200 (24 < 50).
  var r1 = await f.rounding.roundFor({ amount_minor: 1234, currency: "JPY", kind: "cart_total" });
  check("JPY 1234 -> 1200",              r1.rounded_minor === 1200);

  // 1250 yen -> 1300 (half_up at the tie -> upper).
  var r2 = await f.rounding.roundFor({ amount_minor: 1250, currency: "JPY", kind: "cart_total" });
  check("JPY 1250 half_up -> 1300",      r2.rounded_minor === 1300);

  // 1299 -> 1300.
  var r3 = await f.rounding.roundFor({ amount_minor: 1299, currency: "JPY", kind: "cart_total" });
  check("JPY 1299 -> 1300",              r3.rounded_minor === 1300);

  // 1300 -> 1300 (on the increment, no-op).
  var r4 = await f.rounding.roundFor({ amount_minor: 1300, currency: "JPY", kind: "cart_total" });
  check("JPY 1300 -> 1300 no-op",        r4.rounded_minor === 1300);
}

async function _sekTenOreStep() {
  var f = _factory();
  await f.rounding.defineRule({
    currency:        "SEK",
    increment_minor: 10,
    mode:            "half_up",
    applies_to:      "cart_total",
  });

  // 12.47 SEK -> 12.50 (rem=7 > half=5).
  var r1 = await f.rounding.roundFor({ amount_minor: 1247, currency: "SEK", kind: "cart_total" });
  check("SEK 12.47 -> 12.50",            r1.rounded_minor === 1250);

  // 12.44 SEK -> 12.40 (rem=4 < half=5).
  var r2 = await f.rounding.roundFor({ amount_minor: 1244, currency: "SEK", kind: "cart_total" });
  check("SEK 12.44 -> 12.40",            r2.rounded_minor === 1240);

  // 12.45 SEK -> 12.50 (half_up at tie).
  var r3 = await f.rounding.roundFor({ amount_minor: 1245, currency: "SEK", kind: "cart_total" });
  check("SEK 12.45 half_up -> 12.50",    r3.rounded_minor === 1250);
}

async function _appliesToFiltering() {
  var f = _factory();
  // Rule scoped to cart_total only.
  await f.rounding.defineRule({
    currency:        "CHF",
    increment_minor: 5,
    mode:            "half_up",
    applies_to:      "cart_total",
  });

  // cart_total call — rule applies.
  var r1 = await f.rounding.roundFor({ amount_minor: 1287, currency: "CHF", kind: "cart_total" });
  check("cart_total in-scope rounded",   r1.rounded_minor === 1285 && r1.adjustment_minor === -2);

  // line_total call — rule does NOT apply (scope mismatch).
  var r2 = await f.rounding.roundFor({ amount_minor: 1287, currency: "CHF", kind: "line_total" });
  check("line_total out-of-scope",       r2.rounded_minor === 1287 && r2.adjustment_minor === 0);

  // display_only call — also out of scope.
  var r3 = await f.rounding.roundFor({ amount_minor: 1287, currency: "CHF", kind: "display_only" });
  check("display_only out-of-scope",     r3.rounded_minor === 1287 && r3.adjustment_minor === 0);

  // Update the rule to applies_to=all and verify every kind now snaps.
  await f.rounding.updateRule("CHF", { applies_to: "all" });
  var r4 = await f.rounding.roundFor({ amount_minor: 1287, currency: "CHF", kind: "line_total" });
  check("after all-scope line_total",    r4.rounded_minor === 1285);
  var r5 = await f.rounding.roundFor({ amount_minor: 1287, currency: "CHF", kind: "display_only" });
  check("after all-scope display_only",  r5.rounded_minor === 1285);

  // Currency with no rule — pass through.
  var r6 = await f.rounding.roundFor({ amount_minor: 1287, currency: "EUR", kind: "cart_total" });
  check("no rule pass-through",          r6.rounded_minor === 1287 && r6.adjustment_minor === 0);
}

async function _historyForCurrencyAudit() {
  var f = _factory();
  await f.rounding.defineRule({
    currency:        "CHF",
    increment_minor: 5,
    mode:            "half_up",
    applies_to:      "all",
  });

  await f.rounding.roundFor({ amount_minor: 1287, currency: "CHF", kind: "cart_total" });
  await f.rounding.roundFor({ amount_minor: 1288, currency: "CHF", kind: "cart_total" });
  await f.rounding.roundFor({ amount_minor: 1250, currency: "CHF", kind: "cart_total" }); // no-op but still logged
  await f.rounding.roundFor({ amount_minor:  997, currency: "CHF", kind: "line_total" });

  var hist = await f.rounding.historyForCurrency({ currency: "CHF" });
  check("history captures all 4 rounds", hist.length === 4);

  // Newest-first ordering.
  check("history order newest first",    hist[0].occurred_at >= hist[1].occurred_at
                                          && hist[1].occurred_at >= hist[2].occurred_at);

  // Adjustments persisted correctly.
  // hist[0] is the latest write (997 -> 995, adj=-2).
  check("history adjustment 997->995",    hist[0].original_minor === 997
                                            && hist[0].rounded_minor === 995
                                            && hist[0].adjustment_minor === -2);

  // The 1250 no-op still appears.
  var noops = hist.filter(function (r) { return r.adjustment_minor === 0; });
  check("history includes no-op rows",    noops.length === 1 && noops[0].original_minor === 1250);

  // historyForCurrency for a currency with no log returns empty.
  // Use a different ISO 4217 code that the catalog knows.
  var empty = await f.rounding.historyForCurrency({ currency: "EUR" });
  check("history empty for unused ccy",   empty.length === 0);

  // Window filter — `from` bound excludes the oldest row.
  var allTs = hist.map(function (r) { return r.occurred_at; }).sort(function (a, b) { return a - b; });
  var midpoint = allTs[1];   // second-oldest
  var filtered = await f.rounding.historyForCurrency({ currency: "CHF", from: midpoint });
  check("history from-filter shrinks",    filtered.length >= 1 && filtered.length < hist.length);
}

async function _updateAndArchive() {
  var f = _factory();
  await f.rounding.defineRule({
    currency:        "CHF",
    increment_minor: 5,
    mode:            "half_up",
    applies_to:      "cart_total",
  });

  // Update mode.
  var up = await f.rounding.updateRule("CHF", { mode: "half_even" });
  check("updateRule mode change",          up.mode === "half_even");
  check("updateRule retains increment",    up.increment_minor === 5);

  // Update with empty patch refuses.
  await assert.rejects(f.rounding.updateRule("CHF", {}), /at least one/);

  // Archive.
  var arc = await f.rounding.archiveRule("CHF");
  check("archiveRule sets inactive",       arc.active === false && arc.archived_at !== null);

  // listRules({ active_only: true }) returns nothing.
  var activeOnly = await f.rounding.listRules({ active_only: true });
  check("listRules active_only post-arc",  activeOnly.length === 0);

  // listRules default returns the archived row.
  var all = await f.rounding.listRules({});
  check("listRules sees archived row",     all.length === 1 && all[0].active === false);

  // roundFor for archived currency passes through.
  var r = await f.rounding.roundFor({ amount_minor: 1287, currency: "CHF", kind: "cart_total" });
  check("archived rule no longer rounds",  r.rounded_minor === 1287 && r.adjustment_minor === 0);

  // Idempotent re-archive.
  var arc2 = await f.rounding.archiveRule("CHF");
  check("re-archive idempotent",           arc2.active === false);

  // updateRule on an archived rule refuses (operator must re-define).
  await assert.rejects(f.rounding.updateRule("CHF", { mode: "half_up" }), /archived/);

  // Re-define after archive: re-activates with new params.
  var re = await f.rounding.defineRule({
    currency:        "CHF",
    increment_minor: 25,
    mode:            "floor",
    applies_to:      "all",
  });
  check("re-define post-archive active",   re.active === true && re.increment_minor === 25
                                            && re.mode === "floor"
                                            && re.archived_at === null);

  // Archive of a non-existent rule refuses.
  await assert.rejects(f.rounding.archiveRule("EUR"), /no rule exists/);

  // updateRule on a non-existent rule refuses.
  await assert.rejects(f.rounding.updateRule("EUR", { mode: "half_up" }), /no rule exists/);
}

async function _validation() {
  var f = _factory();

  // defineRule
  await assert.rejects(f.rounding.defineRule(),                                                            /input object required/);
  await assert.rejects(f.rounding.defineRule({ currency: "us", increment_minor: 1, mode: "half_up", applies_to: "all" }),       /ISO 4217/);
  await assert.rejects(f.rounding.defineRule({ currency: "USD", increment_minor: 0, mode: "half_up", applies_to: "all" }),      /increment_minor/);
  await assert.rejects(f.rounding.defineRule({ currency: "USD", increment_minor: -1, mode: "half_up", applies_to: "all" }),     /increment_minor/);
  await assert.rejects(f.rounding.defineRule({ currency: "USD", increment_minor: 1.5, mode: "half_up", applies_to: "all" }),    /increment_minor/);

  // roundFor
  await assert.rejects(f.rounding.roundFor(),                                                              /input object required/);
  await assert.rejects(f.rounding.roundFor({ amount_minor: "nope", currency: "USD", kind: "cart_total" }), /amount_minor/);
  await assert.rejects(f.rounding.roundFor({ amount_minor: 1.5,   currency: "USD", kind: "cart_total" }),  /amount_minor/);
  await assert.rejects(f.rounding.roundFor({ amount_minor: 100,   currency: "us",  kind: "cart_total" }),  /ISO 4217/);
  await assert.rejects(f.rounding.roundFor({ amount_minor: 100,   currency: "USD", kind: "weird" }),       /applies_to/);

  // getRule
  await assert.rejects(f.rounding.getRule("us"),                                                            /ISO 4217/);

  // listRules
  await assert.rejects(f.rounding.listRules({ active_only: "yes" }),                                       /active_only/);
  await assert.rejects(f.rounding.listRules({ limit: 0 }),                                                 /limit/);
  await assert.rejects(f.rounding.listRules({ limit: 99999 }),                                             /limit/);

  // updateRule
  await assert.rejects(f.rounding.updateRule("USD"),                                                       /patch object required/);
  await assert.rejects(f.rounding.updateRule("us", { mode: "half_up" }),                                   /ISO 4217/);

  // archiveRule
  await assert.rejects(f.rounding.archiveRule("us"),                                                       /ISO 4217/);

  // historyForCurrency
  await assert.rejects(f.rounding.historyForCurrency(),                                                    /input object required/);
  await assert.rejects(f.rounding.historyForCurrency({ currency: "us" }),                                  /ISO 4217/);
  await assert.rejects(f.rounding.historyForCurrency({ currency: "USD", from: -1 }),                       /from/);
  await assert.rejects(f.rounding.historyForCurrency({ currency: "USD", to: "nope" }),                     /to/);
  await assert.rejects(f.rounding.historyForCurrency({ currency: "USD", limit: 0 }),                       /limit/);

  // create factory
  assert.throws(function () { currencyRounding.create({ query: "not a fn" }); }, /query must be a function/);
}

async function _exportedConstants() {
  check("MODES exported",                  Array.isArray(currencyRounding.MODES)
                                            && currencyRounding.MODES.indexOf("half_up")   !== -1
                                            && currencyRounding.MODES.indexOf("half_even") !== -1
                                            && currencyRounding.MODES.indexOf("half_down") !== -1
                                            && currencyRounding.MODES.indexOf("ceiling")   !== -1
                                            && currencyRounding.MODES.indexOf("floor")     !== -1);
  check("APPLIES_TO exported",             Array.isArray(currencyRounding.APPLIES_TO)
                                            && currencyRounding.APPLIES_TO.indexOf("display_only") !== -1
                                            && currencyRounding.APPLIES_TO.indexOf("cart_total")    !== -1
                                            && currencyRounding.APPLIES_TO.indexOf("line_total")    !== -1
                                            && currencyRounding.APPLIES_TO.indexOf("all")           !== -1);
  check("round helper exported",           typeof currencyRounding.round === "function");

  var inst = currencyRounding.create({ query: _makeQuery().query });
  check("instance exposes MODES",          inst.MODES.length === 5);
  check("instance exposes APPLIES_TO",     inst.APPLIES_TO.length === 4);
}

async function run() {
  await _defineRulePerCurrency();
  await _roundForModeEnumeration();
  await _chfRappenrundungMath();
  await _jpyHundredYenStep();
  await _sekTenOreStep();
  await _appliesToFiltering();
  await _historyForCurrencyAudit();
  await _updateAndArchive();
  await _validation();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - currency-rounding (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
