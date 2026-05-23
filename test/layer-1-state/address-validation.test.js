"use strict";
/**
 * addressValidation — operator-supplied address normalization +
 * autocomplete proxy cache.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0115.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/address-validation.js` directly so the gate exists ahead of
 * the entry-point edit.
 *
 * Coverage:
 *   - recordValidation persists every column + hydrates the round-
 *     trip; lookupCached returns the same row on cache hit
 *   - identical raw input with shuffled key order produces the same
 *     signature (canonical-JSON normalization) so the cache row is
 *     reused, not duplicated
 *   - expired row (expires_at <= now) is reported as a cache miss by
 *     lookupCached but stays on disk until cleanupExpired runs
 *   - recordValidation against an existing input_signature upserts
 *     in place (same id, refreshed columns)
 *   - recordSuggestion + lookupSuggestions round-trip + expiry parity
 *     with the validations table
 *   - cleanupExpired sweeps stale rows from both tables and is
 *     idempotent on a second call
 *   - metricsForSource buckets by classification + deliverable inside
 *     the [from, to] occurred_at window
 *   - validationsForOrder returns rows tagged with the requested
 *     order_id newest-first; untagged rows are excluded
 *   - input refusals: bad source / classification / expires_at /
 *     non-object input / non-array suggestions / control bytes in
 *     partial_input
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

require("../../lib");                                                       // ensure entry-point loads + the framework handle works for lazy require
var addressValidation = require("../../lib/address-validation");
var helpers           = require("../helpers");
var check             = helpers.check;
var assert            = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0115_address_validation.sql"
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

function _setup() {
  var query = _makeQuery();
  var av    = addressValidation.create({ query: query });
  return { query: query, av: av };
}

// `T0` is the present wall-clock instant captured once at module
// load. `lookupCached` consults `Date.now()` when comparing against
// expires_at, so fresh rows are anchored to a real-future epoch and
// expired rows sit behind T0. The occurred_at axis is operator-
// chosen and not bound to wall clock.
var T0 = Date.now();
function _later(secs) { return T0 + secs * 1000; }

// ---- record + lookup happy path + signature stability -----------------

async function _recordAndLookup() {
  var s = _setup();

  var addr = {
    line1:   "1600 Pennsylvania Ave NW",
    city:    "Washington",
    region:  "DC",
    postal:  "20500",
    country: "US",
  };
  var normalized = {
    line1:   "1600 PENNSYLVANIA AVE NW",
    city:    "WASHINGTON",
    region:  "DC",
    postal:  "20500-0003",
    country: "US",
  };

  var rec = await s.av.recordValidation({
    input:              addr,
    normalized_address: normalized,
    deliverable:        true,
    classification:     "commercial",
    dpv_match:          "Y",
    source:             "usps",
    order_id:           "order-1",
    expires_at:         _later(3600),
    occurred_at:        T0,
  });
  check("record returns id",                  typeof rec.id === "string" && rec.id.length > 0);
  check("record input_signature shape",       /^[0-9a-f]{128}$/.test(rec.input_signature));
  check("record normalized round-trip",       rec.normalized_address.line1 === "1600 PENNSYLVANIA AVE NW");
  check("record deliverable",                 rec.deliverable === true);
  check("record classification",              rec.classification === "commercial");
  check("record dpv_match",                   rec.dpv_match === "Y");
  check("record source",                      rec.source === "usps");
  check("record order_id",                    rec.order_id === "order-1");
  check("record expires_at",                  rec.expires_at === _later(3600));
  check("record occurred_at",                 rec.occurred_at === T0);

  // lookupCached against the SAME input shape returns the same row.
  var hit = await s.av.lookupCached(addr);
  check("lookupCached hit not null",          hit !== null);
  check("lookupCached hit id matches",        hit.id === rec.id);
  check("lookupCached hit signature matches", hit.input_signature === rec.input_signature);

  // Same address, shuffled key order — canonical-JSON normalization
  // hashes identically, so the SAME cache row is returned.
  var shuffled = {
    country: "US",
    postal:  "20500",
    region:  "DC",
    city:    "Washington",
    line1:   "1600 Pennsylvania Ave NW",
  };
  var hitShuffled = await s.av.lookupCached(shuffled);
  check("lookupCached canonical insensitive",         hitShuffled !== null);
  check("lookupCached canonical same id",             hitShuffled.id === rec.id);

  // signatureFor exposes the same derivation.
  var sig = s.av.signatureFor(shuffled);
  check("signatureFor matches recorded sig",          sig === rec.input_signature);

  // Cache miss for a different address.
  var miss = await s.av.lookupCached({
    line1: "Different Street", city: "Nowhere",
    region: "ZZ", postal: "00000", country: "US",
  });
  check("lookupCached miss returns null",             miss === null);
}

// ---- expired row reads as miss ---------------------------------------

async function _expiredReadsAsMiss() {
  var s = _setup();

  var addr = { line1: "1 Main", city: "Townsville", region: "TX", postal: "75001", country: "US" };
  var rec = await s.av.recordValidation({
    input:              addr,
    normalized_address: { line1: "1 MAIN", city: "TOWNSVILLE", region: "TX", postal: "75001", country: "US" },
    deliverable:        true,
    classification:     "residential",
    source:             "smarty",
    expires_at:         _later(-1),                                // already expired by 1s
    occurred_at:        T0,
  });
  check("record expired row inserted",        rec !== null);

  // Real-clock now is well past T0 + (-1s); lookupCached treats the
  // row as a cache miss.
  var hit = await s.av.lookupCached(addr);
  check("expired row reads as miss",          hit === null);

  // Row still on disk — cleanupExpired will remove it. Verify via
  // metricsForSource which counts present rows regardless of expiry.
  var metrics = await s.av.metricsForSource({
    slug: "smarty",
    from: 0,
    to:   _later(3600),
  });
  check("expired row still present pre-cleanup", metrics.total === 1);
}

// ---- upsert preserves id, refreshes columns --------------------------

async function _upsertSemantics() {
  var s = _setup();

  var addr = { line1: "10 Pine", city: "Portland", region: "OR", postal: "97201", country: "US" };

  var first = await s.av.recordValidation({
    input:              addr,
    normalized_address: { line1: "10 PINE", city: "PORTLAND", region: "OR", postal: "97201", country: "US" },
    deliverable:        true,
    classification:     "residential",
    source:             "lob",
    expires_at:         _later(60),
    occurred_at:        T0,
  });

  // Second write with a different source + tighter expiry; same input
  // signature -> same row id, refreshed columns.
  var second = await s.av.recordValidation({
    input:              addr,
    normalized_address: { line1: "10 PINE ST", city: "PORTLAND", region: "OR", postal: "97201-1234", country: "US" },
    deliverable:        true,
    classification:     "residential",
    source:             "google",
    dpv_match:          null,
    expires_at:         _later(120),
    occurred_at:        T0 + 1000,
  });
  check("upsert preserves id",                    second.id === first.id);
  check("upsert refreshes source",                second.source === "google");
  check("upsert refreshes normalized line1",      second.normalized_address.line1 === "10 PINE ST");
  check("upsert refreshes expires_at",            second.expires_at === _later(120));
  check("upsert refreshes occurred_at",           second.occurred_at === T0 + 1000);
}

// ---- recordSuggestion + lookupSuggestions ---------------------------

async function _suggestionCache() {
  var s = _setup();

  var partial = "1600 Penn";
  var suggestions = [
    { line1: "1600 Pennsylvania Ave NW", city: "Washington", region: "DC" },
    { line1: "1600 Pennsylvania St",     city: "Denver",     region: "CO" },
  ];
  var rec = await s.av.recordSuggestion({
    partial_input: partial,
    suggestions:   suggestions,
    expires_at:    _later(3600),
    occurred_at:   T0,
  });
  check("recordSuggestion partial_input round-trip", rec.partial_input === partial);
  check("recordSuggestion suggestions length",       rec.suggestions.length === 2);
  check("recordSuggestion first city",               rec.suggestions[0].city === "Washington");

  var hit = await s.av.lookupSuggestions(partial);
  check("lookupSuggestions hit not null",            hit !== null);
  check("lookupSuggestions hit id matches",          hit.id === rec.id);
  check("lookupSuggestions hit suggestions length",  hit.suggestions.length === 2);

  // Miss
  var miss = await s.av.lookupSuggestions("zzzzz");
  check("lookupSuggestions miss returns null",       miss === null);

  // Upsert
  var rec2 = await s.av.recordSuggestion({
    partial_input: partial,
    suggestions:   [{ line1: "1600 Pennsylvania Ave SE", city: "Washington", region: "DC" }],
    expires_at:    _later(120),
    occurred_at:   T0 + 1000,
  });
  check("recordSuggestion upsert preserves id",      rec2.id === rec.id);
  check("recordSuggestion upsert refreshes count",   rec2.suggestions.length === 1);

  // Expired suggestion -> miss.
  await s.av.recordSuggestion({
    partial_input: "10 Pine St, Por",
    suggestions:   [{ line1: "10 Pine St", city: "Portland", region: "OR" }],
    expires_at:    _later(-1),
    occurred_at:   T0,
  });
  var expiredMiss = await s.av.lookupSuggestions("10 Pine St, Por");
  check("expired suggestion reads as miss",          expiredMiss === null);
}

// ---- cleanupExpired -------------------------------------------------

async function _cleanupExpired() {
  var s = _setup();

  // Two expired validations + one fresh.
  await s.av.recordValidation({
    input:              { line1: "X1", city: "X", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "X1", city: "X", region: "TX", postal: "75001", country: "US" },
    deliverable: true, classification: "residential", source: "usps",
    expires_at: 100, occurred_at: 50,
  });
  await s.av.recordValidation({
    input:              { line1: "X2", city: "X", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "X2", city: "X", region: "TX", postal: "75001", country: "US" },
    deliverable: true, classification: "residential", source: "usps",
    expires_at: 200, occurred_at: 50,
  });
  await s.av.recordValidation({
    input:              { line1: "Y1", city: "Y", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "Y1", city: "Y", region: "TX", postal: "75001", country: "US" },
    deliverable: true, classification: "residential", source: "usps",
    expires_at: 9_999_999_999_999, occurred_at: 50,
  });

  // Two expired suggestions + one fresh.
  await s.av.recordSuggestion({
    partial_input: "P1", suggestions: [], expires_at: 100, occurred_at: 50,
  });
  await s.av.recordSuggestion({
    partial_input: "P2", suggestions: [], expires_at: 200, occurred_at: 50,
  });
  await s.av.recordSuggestion({
    partial_input: "P3", suggestions: [], expires_at: 9_999_999_999_999, occurred_at: 50,
  });

  var swept = await s.av.cleanupExpired({ now: 300 });
  check("cleanup swept validations",            swept.validations === 2);
  check("cleanup swept suggestions",            swept.suggestions === 2);
  check("cleanup now passthrough",              swept.now === 300);

  // Idempotent.
  var sweptAgain = await s.av.cleanupExpired({ now: 300 });
  check("cleanup idempotent validations",       sweptAgain.validations === 0);
  check("cleanup idempotent suggestions",       sweptAgain.suggestions === 0);
}

// ---- metricsForSource ----------------------------------------------

async function _metrics() {
  var s = _setup();

  // Seed: 2 USPS commercial deliverable, 1 USPS residential
  // undeliverable, 1 Smarty residential deliverable. All inside the
  // window.
  await s.av.recordValidation({
    input:              { line1: "C1", city: "X", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "C1", city: "X", region: "TX", postal: "75001", country: "US" },
    deliverable: true, classification: "commercial", source: "usps",
    expires_at: _later(3600), occurred_at: T0 + 1000,
  });
  await s.av.recordValidation({
    input:              { line1: "C2", city: "X", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "C2", city: "X", region: "TX", postal: "75001", country: "US" },
    deliverable: true, classification: "commercial", source: "usps",
    expires_at: _later(3600), occurred_at: T0 + 2000,
  });
  await s.av.recordValidation({
    input:              { line1: "R1", city: "X", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "R1", city: "X", region: "TX", postal: "75001", country: "US" },
    deliverable: false, classification: "residential", source: "usps",
    expires_at: _later(3600), occurred_at: T0 + 3000,
  });
  await s.av.recordValidation({
    input:              { line1: "S1", city: "X", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "S1", city: "X", region: "TX", postal: "75001", country: "US" },
    deliverable: true, classification: "residential", source: "smarty",
    expires_at: _later(3600), occurred_at: T0 + 4000,
  });
  // One outside the window — must not count.
  await s.av.recordValidation({
    input:              { line1: "OUT", city: "X", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "OUT", city: "X", region: "TX", postal: "75001", country: "US" },
    deliverable: true, classification: "commercial", source: "usps",
    expires_at: _later(3600), occurred_at: T0 + 10_000_000,
  });

  var m = await s.av.metricsForSource({
    slug: "usps",
    from: T0,
    to:   T0 + 10000,
  });
  check("metrics source",                       m.source === "usps");
  check("metrics from/to",                      m.from === T0 && m.to === T0 + 10000);
  check("metrics total inside window",          m.total === 3);
  // Two buckets: commercial/deliverable=true (count=2),
  // residential/deliverable=false (count=1).
  var commercial = null, residential = null;
  for (var i = 0; i < m.buckets.length; i += 1) {
    if (m.buckets[i].classification === "commercial") commercial = m.buckets[i];
    if (m.buckets[i].classification === "residential") residential = m.buckets[i];
  }
  check("metrics commercial bucket count",      commercial && commercial.count === 2);
  check("metrics commercial deliverable true",  commercial && commercial.deliverable === true);
  check("metrics residential bucket count",     residential && residential.count === 1);
  check("metrics residential deliverable false", residential && residential.deliverable === false);

  // Smarty source is a separate aggregate.
  var smarty = await s.av.metricsForSource({
    slug: "smarty",
    from: T0,
    to:   T0 + 10000,
  });
  check("metrics smarty total",                 smarty.total === 1);

  // Refusals.
  await assert.rejects(s.av.metricsForSource(), /input object required/);
  await assert.rejects(s.av.metricsForSource({ slug: "bogus", from: 0, to: 1 }), /source/);
  await assert.rejects(s.av.metricsForSource({ slug: "usps", from: 100, to: 50 }), /to must be >= from/);
}

// ---- validationsForOrder ------------------------------------------

async function _validationsForOrder() {
  var s = _setup();

  await s.av.recordValidation({
    input:              { line1: "O1A", city: "X", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "O1A", city: "X", region: "TX", postal: "75001", country: "US" },
    deliverable: true, classification: "residential", source: "usps",
    order_id: "order-1", expires_at: _later(3600), occurred_at: T0 + 1000,
  });
  await s.av.recordValidation({
    input:              { line1: "O1B", city: "X", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "O1B", city: "X", region: "TX", postal: "75001", country: "US" },
    deliverable: true, classification: "commercial", source: "lob",
    order_id: "order-1", expires_at: _later(3600), occurred_at: T0 + 2000,
  });
  await s.av.recordValidation({
    input:              { line1: "O2A", city: "X", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "O2A", city: "X", region: "TX", postal: "75001", country: "US" },
    deliverable: true, classification: "residential", source: "usps",
    order_id: "order-2", expires_at: _later(3600), occurred_at: T0 + 3000,
  });
  // Untagged row — must not appear in either order's list.
  await s.av.recordValidation({
    input:              { line1: "NONE", city: "X", region: "TX", postal: "75001", country: "US" },
    normalized_address: { line1: "NONE", city: "X", region: "TX", postal: "75001", country: "US" },
    deliverable: true, classification: "residential", source: "usps",
    expires_at: _later(3600), occurred_at: T0 + 4000,
  });

  var o1 = await s.av.validationsForOrder("order-1");
  check("validationsForOrder count",           o1.length === 2);
  check("validationsForOrder newest first",    o1[0].occurred_at > o1[1].occurred_at);
  check("validationsForOrder both tagged",     o1[0].order_id === "order-1" && o1[1].order_id === "order-1");

  var o2 = await s.av.validationsForOrder("order-2");
  check("validationsForOrder other order",     o2.length === 1 && o2[0].order_id === "order-2");

  var missing = await s.av.validationsForOrder("order-missing");
  check("validationsForOrder unknown empty",   missing.length === 0);

  // Refusals.
  await assert.rejects(s.av.validationsForOrder(""), /order_id/);
  await assert.rejects(s.av.validationsForOrder(123), /order_id/);
}

// ---- input refusals ----------------------------------------------

async function _refusals() {
  var s = _setup();

  await assert.rejects(s.av.recordValidation(), /input object required/);
  await assert.rejects(s.av.recordValidation({
    input: null,
    normalized_address: { a: 1 },
    deliverable: true, classification: "residential",
    source: "usps", expires_at: T0,
  }), /input is required/);
  await assert.rejects(s.av.recordValidation({
    input: { a: 1 },
    normalized_address: { a: 1 },
    deliverable: "yes", classification: "residential",
    source: "usps", expires_at: T0,
  }), /deliverable/);
  await assert.rejects(s.av.recordValidation({
    input: { a: 1 },
    normalized_address: { a: 1 },
    deliverable: true, classification: "bogus",
    source: "usps", expires_at: T0,
  }), /classification/);
  await assert.rejects(s.av.recordValidation({
    input: { a: 1 },
    normalized_address: { a: 1 },
    deliverable: true, classification: "residential",
    source: "bogus", expires_at: T0,
  }), /source/);
  await assert.rejects(s.av.recordValidation({
    input: { a: 1 },
    normalized_address: { a: 1 },
    deliverable: true, classification: "residential",
    source: "usps", expires_at: -1,
  }), /expires_at/);
  await assert.rejects(s.av.recordValidation({
    input: { a: 1 },
    normalized_address: "not-an-object",
    deliverable: true, classification: "residential",
    source: "usps", expires_at: T0,
  }), /normalized_address/);

  await assert.rejects(s.av.recordSuggestion(), /input object required/);
  await assert.rejects(s.av.recordSuggestion({
    partial_input: "", suggestions: [], expires_at: T0,
  }), /partial_input/);
  await assert.rejects(s.av.recordSuggestion({
    partial_input: "ok", suggestions: "not-array", expires_at: T0,
  }), /suggestions/);
  await assert.rejects(s.av.recordSuggestion({
    partial_input: "has\x00null", suggestions: [], expires_at: T0,
  }), /partial_input/);

  await assert.rejects(s.av.lookupCached(null), /input is required/);
  await assert.rejects(s.av.lookupCached("string"), /input must be a plain object/);
  await assert.rejects(s.av.lookupSuggestions(""), /partial_input/);
}

async function run() {
  await _recordAndLookup();
  await _expiredReadsAsMiss();
  await _upsertSemantics();
  await _suggestionCache();
  await _cleanupExpired();
  await _metrics();
  await _validationsForOrder();
  await _refusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - address-validation (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - address-validation: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
