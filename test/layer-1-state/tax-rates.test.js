"use strict";
/**
 * taxRates — operator-managed per-jurisdiction tax-rate table with
 * scheduled effective dates.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0058.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/tax-rates.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineRate happy path + persistence shape (id / archived_at
 *     null / created_at stamped)
 *   - rateFor with on_date inside the window resolves the row
 *   - rateFor with on_date outside the window returns null
 *   - rateFor with a category-specific row beats the NULL-category
 *     fallback; NULL fallback still resolves when the requested
 *     category has no live row
 *   - defineRate refuses overlapping (jurisdiction, category) windows
 *   - bulkImport happy path + refuses overlap inside the same batch
 *   - scheduledChanges returns rows whose effective_from OR
 *     effective_until lands in [from, to]
 *   - input refusals (bad jurisdiction shape, bad source, bad
 *     category, bad rate_bps, effective_until <= effective_from)
 *   - listForJurisdiction + updateRate + archiveRate lifecycle
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop    = require("../../lib");
var taxRates = require("../../lib/tax-rates");
var helpers  = require("../helpers");
var check    = helpers.check;
var assert   = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0058_tax_rates.sql"
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

function _validUUID() { return bShop.framework.uuid.v7(); }

function _setup() {
  var query = _makeQuery();
  var rates = taxRates.create({ query: query });
  return { query: query, rates: rates };
}

// Fixed dates so the suite is deterministic regardless of clock.
var T_2026_01_01 = Date.UTC(2026,  0,  1);
var T_2026_07_01 = Date.UTC(2026,  6,  1);
var T_2027_01_01 = Date.UTC(2027,  0,  1);
var T_2025_06_01 = Date.UTC(2025,  5,  1);

async function _defineHappyPath() {
  var ctx = _setup();
  var r = await ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       1900,
    effective_from: T_2026_01_01,
    source:         "manual",
  });
  check("defineRate returns row",                  r && typeof r === "object");
  check("defineRate stamps 36-char uuid id",       typeof r.id === "string" && r.id.length === 36);
  check("defineRate persists jurisdiction",        r.jurisdiction === "DE");
  check("defineRate persists rate_bps",            Number(r.rate_bps) === 1900);
  check("defineRate persists effective_from",      Number(r.effective_from) === T_2026_01_01);
  check("defineRate effective_until null default", r.effective_until == null);
  check("defineRate category null default",        r.category == null);
  check("defineRate persists source",              r.source === "manual");
  check("defineRate opens with archived_at null",  r.archived_at == null);
  check("defineRate stamps created_at",            typeof r.created_at === "number");
  check("defineRate stamps updated_at",            typeof r.updated_at === "number");

  // Subdivision-style jurisdiction accepted.
  var sub = await ctx.rates.defineRate({
    jurisdiction:   "US-CA",
    rate_bps:        875,
    effective_from: T_2026_01_01,
    source:         "state_dept",
  });
  check("defineRate accepts subdivision shape",    sub.jurisdiction === "US-CA");
}

async function _rateForWindow() {
  var ctx = _setup();
  await ctx.rates.defineRate({
    jurisdiction:    "DE",
    rate_bps:        1900,
    effective_from:  T_2026_01_01,
    effective_until: T_2027_01_01,
    source:          "manual",
  });

  // In-window resolves.
  var inside = await ctx.rates.rateFor({ jurisdiction: "DE", on_date: T_2026_07_01 });
  check("rateFor inside window resolves row",      inside && Number(inside.rate_bps) === 1900);

  // Edge: effective_from is inclusive.
  var edgeFrom = await ctx.rates.rateFor({ jurisdiction: "DE", on_date: T_2026_01_01 });
  check("rateFor at effective_from is inclusive",  edgeFrom && Number(edgeFrom.rate_bps) === 1900);

  // Edge: effective_until is exclusive.
  var edgeUntil = await ctx.rates.rateFor({ jurisdiction: "DE", on_date: T_2027_01_01 });
  check("rateFor at effective_until is exclusive", edgeUntil === null);

  // Before window.
  var before = await ctx.rates.rateFor({ jurisdiction: "DE", on_date: T_2025_06_01 });
  check("rateFor before effective_from returns null", before === null);

  // After window.
  var after = await ctx.rates.rateFor({
    jurisdiction: "DE",
    on_date:      Date.UTC(2028, 0, 1),
  });
  check("rateFor after effective_until returns null", after === null);

  // Jurisdiction miss.
  var miss = await ctx.rates.rateFor({ jurisdiction: "FR", on_date: T_2026_07_01 });
  check("rateFor unknown jurisdiction returns null",  miss === null);
}

async function _categorySpecificity() {
  var ctx = _setup();
  // Default (NULL category) jurisdiction rate.
  await ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       1900,
    effective_from: T_2026_01_01,
    source:         "manual",
  });
  // Category-specific reduced rate (e.g. food).
  await ctx.rates.defineRate({
    jurisdiction:   "DE",
    category:       "food",
    rate_bps:        700,
    effective_from: T_2026_01_01,
    source:         "manual",
  });

  var food = await ctx.rates.rateFor({
    jurisdiction: "DE",
    category:     "food",
    on_date:      T_2026_07_01,
  });
  check("rateFor category-specific wins",          food && Number(food.rate_bps) === 700);
  check("rateFor category-specific row category",  food.category === "food");

  // Unmapped category falls back to NULL-category default.
  var digital = await ctx.rates.rateFor({
    jurisdiction: "DE",
    category:     "digital",
    on_date:      T_2026_07_01,
  });
  check("rateFor falls back to NULL category",     digital && Number(digital.rate_bps) === 1900);
  check("rateFor fallback row has null category",  digital.category == null);

  // No category supplied returns the NULL-category default directly.
  var noCat = await ctx.rates.rateFor({
    jurisdiction: "DE",
    on_date:      T_2026_07_01,
  });
  check("rateFor with no category -> NULL row",    noCat && Number(noCat.rate_bps) === 1900);
}

async function _overlappingRefusal() {
  var ctx = _setup();
  await ctx.rates.defineRate({
    jurisdiction:    "DE",
    rate_bps:        1900,
    effective_from:  T_2026_01_01,
    effective_until: T_2027_01_01,
    source:          "manual",
  });

  // Fully-contained window — refused.
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:    "DE",
    rate_bps:        2000,
    effective_from:  T_2026_07_01,
    effective_until: Date.UTC(2026, 9, 1),
    source:          "manual",
  }), /overlap/i);

  // Straddling left edge — refused.
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:    "DE",
    rate_bps:        2000,
    effective_from:  T_2025_06_01,
    effective_until: T_2026_07_01,
    source:          "manual",
  }), /overlap/i);

  // Open-ended overlap (no effective_until) on the same window — refused.
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       2000,
    effective_from: T_2026_07_01,
    source:         "manual",
  }), /overlap/i);

  // Adjacent (touching but not overlapping) is allowed — the previous
  // row's effective_until is exclusive.
  var adj = await ctx.rates.defineRate({
    jurisdiction:    "DE",
    rate_bps:        2000,
    effective_from:  T_2027_01_01,
    source:          "manual",
  });
  check("adjacent define accepted",                adj && Number(adj.rate_bps) === 2000);

  // Different (category) doesn't conflict.
  var cat = await ctx.rates.defineRate({
    jurisdiction:    "DE",
    category:        "food",
    rate_bps:         700,
    effective_from:  T_2026_01_01,
    source:          "manual",
  });
  check("different category does not overlap",     cat && cat.category === "food");
}

async function _bulkImport() {
  var ctx = _setup();
  var ids = await ctx.rates.bulkImport([
    { jurisdiction: "DE", rate_bps: 1900, effective_from: T_2026_01_01, source: "manual" },
    { jurisdiction: "FR", rate_bps: 2000, effective_from: T_2026_01_01, source: "manual" },
    { jurisdiction: "DE", category: "food", rate_bps: 700, effective_from: T_2026_01_01, source: "manual" },
  ]);
  check("bulkImport returns id array",             Array.isArray(ids) && ids.length === 3);
  check("bulkImport ids are uuids",                ids.every(function (s) { return typeof s === "string" && s.length === 36; }));

  var de = await ctx.rates.rateFor({ jurisdiction: "DE", on_date: T_2026_07_01 });
  check("bulkImport DE row resolved by rateFor",   de && Number(de.rate_bps) === 1900);

  var fr = await ctx.rates.rateFor({ jurisdiction: "FR", on_date: T_2026_07_01 });
  check("bulkImport FR row resolved by rateFor",   fr && Number(fr.rate_bps) === 2000);

  var deFood = await ctx.rates.rateFor({ jurisdiction: "DE", category: "food", on_date: T_2026_07_01 });
  check("bulkImport DE/food row resolved",         deFood && Number(deFood.rate_bps) === 700);

  // Same-batch overlap refused at the second row.
  await assert.rejects(ctx.rates.bulkImport([
    { jurisdiction: "ES", rate_bps: 2100, effective_from: T_2026_01_01, source: "manual" },
    { jurisdiction: "ES", rate_bps: 1000, effective_from: T_2026_07_01, source: "manual" },
  ]), /overlap/i);

  // Non-array input refused.
  await assert.rejects(ctx.rates.bulkImport("not-array"), /rows must be an array/);

  // Bad row inside the batch refused with explicit error.
  await assert.rejects(ctx.rates.bulkImport([
    { jurisdiction: "IT", rate_bps: 2200, effective_from: T_2026_01_01, source: "manual" },
    { jurisdiction: "BAD", rate_bps: 1000, effective_from: T_2026_07_01, source: "manual" },
  ]), /jurisdiction/);
}

async function _scheduledChanges() {
  var ctx = _setup();
  // A: starts inside the window.
  await ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       1900,
    effective_from: T_2026_07_01,
    source:         "manual",
  });
  // B: ends inside the window (and starts before it).
  await ctx.rates.defineRate({
    jurisdiction:    "FR",
    rate_bps:        2000,
    effective_from:  T_2025_06_01,
    effective_until: T_2026_07_01,
    source:          "manual",
  });
  // C: both endpoints inside the window — should appear twice.
  await ctx.rates.defineRate({
    jurisdiction:    "ES",
    rate_bps:        2100,
    effective_from:  Date.UTC(2026, 2, 1),
    effective_until: Date.UTC(2026, 8, 1),
    source:          "manual",
  });
  // D: entirely outside the window — should not appear.
  await ctx.rates.defineRate({
    jurisdiction:    "IT",
    rate_bps:        2200,
    effective_from:  Date.UTC(2028, 0, 1),
    source:          "manual",
  });

  var from = T_2026_01_01;
  var to   = T_2027_01_01;
  var changes = await ctx.rates.scheduledChanges({ from: from, to: to });

  // A starts; B ends; C starts + C ends = 4 rows.
  check("scheduledChanges returns 4 events",       changes.length === 4);

  var jurisdictions = changes.map(function (c) { return c.jurisdiction + ":" + c.change_kind; });
  check("scheduledChanges includes A starts",      jurisdictions.indexOf("DE:starts") !== -1);
  check("scheduledChanges includes B ends",        jurisdictions.indexOf("FR:ends")   !== -1);
  check("scheduledChanges includes C starts",      jurisdictions.indexOf("ES:starts") !== -1);
  check("scheduledChanges includes C ends",        jurisdictions.indexOf("ES:ends")   !== -1);
  check("scheduledChanges excludes IT (outside)",  jurisdictions.indexOf("IT:starts") === -1);

  // Chronological ordering by change_at.
  for (var i = 1; i < changes.length; i += 1) {
    check("scheduledChanges chronological at i=" + i, changes[i].change_at >= changes[i - 1].change_at);
  }

  // Empty window -> empty result.
  var none = await ctx.rates.scheduledChanges({ from: Date.UTC(2030, 0, 1), to: Date.UTC(2031, 0, 1) });
  check("scheduledChanges empty window -> []",     none.length === 0);

  // from > to refused.
  await assert.rejects(ctx.rates.scheduledChanges({ from: to, to: from }), /from must be <= to/);
}

async function _inputRefusals() {
  var ctx = _setup();
  // Bad jurisdiction shape.
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:   "de",
    rate_bps:       1000,
    effective_from: T_2026_01_01,
    source:         "manual",
  }), /jurisdiction/);
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:   "USA",
    rate_bps:       1000,
    effective_from: T_2026_01_01,
    source:         "manual",
  }), /jurisdiction/);
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:   "US-california",
    rate_bps:       1000,
    effective_from: T_2026_01_01,
    source:         "manual",
  }), /jurisdiction/);

  // Bad source.
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       1000,
    effective_from: T_2026_01_01,
    source:         "weather-channel",
  }), /source/);

  // Bad category.
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:   "DE",
    category:       "Food And Drink",
    rate_bps:       1000,
    effective_from: T_2026_01_01,
    source:         "manual",
  }), /category/);

  // Negative rate.
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       -1,
    effective_from: T_2026_01_01,
    source:         "manual",
  }), /rate_bps/);

  // Rate above 100% (10000 bps).
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       10001,
    effective_from: T_2026_01_01,
    source:         "manual",
  }), /rate_bps/);

  // Non-integer rate.
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       19.5,
    effective_from: T_2026_01_01,
    source:         "manual",
  }), /rate_bps/);

  // effective_until <= effective_from.
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:    "DE",
    rate_bps:        1000,
    effective_from:  T_2026_07_01,
    effective_until: T_2026_01_01,
    source:          "manual",
  }), /effective_until/);

  // Negative timestamp.
  await assert.rejects(ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       1000,
    effective_from: -5,
    source:         "manual",
  }), /effective_from/);

  // Missing input.
  await assert.rejects(ctx.rates.defineRate(null), /input object required/);

  // rateFor missing on_date.
  await assert.rejects(ctx.rates.rateFor({ jurisdiction: "DE" }), /on_date/);
}

async function _lifecycle() {
  var ctx = _setup();
  var r = await ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       1900,
    effective_from: T_2026_01_01,
    source:         "manual",
  });

  // listForJurisdiction — only live + non-expired.
  var list = await ctx.rates.listForJurisdiction({ jurisdiction: "DE" });
  check("listForJurisdiction includes new row",    list.length === 1 && list[0].id === r.id);

  // updateRate — bump rate.
  var bumped = await ctx.rates.updateRate(r.id, { rate_bps: 2100 });
  check("updateRate updates rate_bps",             Number(bumped.rate_bps) === 2100);
  check("updateRate bumps updated_at",             Number(bumped.updated_at) >= Number(r.updated_at));

  // updateRate — close the window.
  var closed = await ctx.rates.updateRate(r.id, { effective_until: T_2027_01_01 });
  check("updateRate sets effective_until",         Number(closed.effective_until) === T_2027_01_01);

  // updateRate — unknown column refused.
  await assert.rejects(ctx.rates.updateRate(r.id, { jurisdiction: "FR" }), /not updatable/);
  await assert.rejects(ctx.rates.updateRate(r.id, { effective_from: T_2027_01_01 }), /not updatable/);

  // updateRate — empty patch refused.
  await assert.rejects(ctx.rates.updateRate(r.id, {}), /at least one column/);

  // updateRate unknown id -> null.
  var noop = await ctx.rates.updateRate(_validUUID(), { rate_bps: 100 });
  check("updateRate unknown -> null",              noop === null);

  // After closing the window the row drops out of the
  // default listForJurisdiction view once "now" passes
  // effective_until — for the deterministic test, that
  // moment is in 2027. To exercise the include_expired
  // path we instead define a second row that's already
  // ended.
  var ended = await ctx.rates.defineRate({
    jurisdiction:    "FR",
    rate_bps:        2000,
    effective_from:  Date.UTC(2020, 0, 1),
    effective_until: Date.UTC(2021, 0, 1),
    source:          "manual",
  });
  var liveFr = await ctx.rates.listForJurisdiction({ jurisdiction: "FR" });
  check("listForJurisdiction skips expired by default", liveFr.length === 0);
  var allFr = await ctx.rates.listForJurisdiction({ jurisdiction: "FR", include_expired: true });
  check("listForJurisdiction include_expired returns history", allFr.length === 1 && allFr[0].id === ended.id);

  // archiveRate — stamps archived_at + drops from rateFor.
  var arch = await ctx.rates.archiveRate(r.id, { reason: "supersede" });
  check("archiveRate stamps archived_at",          typeof arch.archived_at === "number");
  var afterArchive = await ctx.rates.rateFor({ jurisdiction: "DE", on_date: T_2026_07_01 });
  check("archived row excluded from rateFor",      afterArchive === null);

  // updateRate on archived row refused.
  await assert.rejects(ctx.rates.updateRate(r.id, { rate_bps: 100 }), /archived/);

  // archiveRate is idempotent — second call returns the existing
  // archived row without changing archived_at.
  var arch2 = await ctx.rates.archiveRate(r.id);
  check("archiveRate idempotent on archived row",  Number(arch2.archived_at) === Number(arch.archived_at));

  // archiveRate unknown -> null.
  var nullArch = await ctx.rates.archiveRate(_validUUID());
  check("archiveRate unknown -> null",             nullArch === null);

  // After archive, a new row in the same window is accepted.
  var replacement = await ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       1700,
    effective_from: T_2026_01_01,
    source:         "manual",
  });
  check("defineRate replaces archived row",        replacement && Number(replacement.rate_bps) === 1700);
}

async function _updateOverlapRecheck() {
  var ctx = _setup();
  // Two adjacent rows: [2026-01-01, 2027-01-01) and [2027-01-01, ∞).
  var first = await ctx.rates.defineRate({
    jurisdiction:    "DE",
    rate_bps:        1900,
    effective_from:  T_2026_01_01,
    effective_until: T_2027_01_01,
    source:          "manual",
  });
  await ctx.rates.defineRate({
    jurisdiction:   "DE",
    rate_bps:       2000,
    effective_from: T_2027_01_01,
    source:         "manual",
  });

  // Extending the first row's effective_until into the second's
  // window would create overlap — must refuse.
  await assert.rejects(ctx.rates.updateRate(first.id, {
    effective_until: Date.UTC(2027, 6, 1),
  }), /overlap/i);

  // Shortening the first row's effective_until is fine.
  var shorter = await ctx.rates.updateRate(first.id, {
    effective_until: Date.UTC(2026, 9, 1),
  });
  check("updateRate shortens effective_until",     Number(shorter.effective_until) === Date.UTC(2026, 9, 1));

  // Clearing effective_until (open-ended) overlaps with the second row.
  await assert.rejects(ctx.rates.updateRate(first.id, { effective_until: null }), /overlap/i);
}

async function run() {
  await _defineHappyPath();
  await _rateForWindow();
  await _categorySpecificity();
  await _overlappingRefusal();
  await _bulkImport();
  await _scheduledChanges();
  await _inputRefusals();
  await _lifecycle();
  await _updateOverlapRecheck();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/tax-rates.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - tax-rates (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
