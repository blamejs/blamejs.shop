"use strict";
/**
 * searchSynonyms — query rewriting + typo correction for the
 * storefront search input.
 *
 * Layer 1 against an in-memory node:sqlite database. Two migrations
 * are mounted because `learnFromQueries` reads from the
 * `search_query_log` table owned by `searchSuggestions`:
 *
 *   - `0030_search_suggestions.sql` (search_query_log — read source
 *     for the bigram learner)
 *   - `0055_search_synonyms.sql`    (search_synonym_groups +
 *     search_typos + search_stopwords — owned here)
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/search-synonyms.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - addGroup happy: bidirectional + directional groups persist with
 *     canonical-terms ordering
 *   - addGroup refusals: bad slug shape, bad kind, < 2 terms, > cap,
 *     duplicate term, oversize term, control bytes, slug collision
 *   - addTypo + addStopword + removeStopword happy + invalidation of
 *     the rewrite cache
 *   - get/list/update/delete group CRUD round-trip
 *   - rewrite end-to-end: stopword removal + typo correction +
 *     stemming + bidirectional expansion + directional expansion
 *   - rewrite on hostile input: control bytes + zero-width chars are
 *     stripped, not refused (the storefront accepts arbitrary user
 *     input — refusal would denial-of-search legitimate shoppers)
 *   - rewrite max_expansions cap honoured
 *   - rewrite include_corrections=false suppresses the diff
 *   - learnFromQueries heuristic surfaces co-occurring pairs not yet
 *     covered by a synonym group; pairs below min_count and pairs
 *     already in a group are excluded
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var searchSynonyms = require("../../lib/search-synonyms");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

void bShop;   // touch the entry point so the require cycle is exercised

var MIGS = ["0030_search_suggestions.sql", "0055_search_synonyms.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) {
      db.prepare(s).run();
    });
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
  var ss    = searchSynonyms.create({ query: query });
  return { query: query, ss: ss };
}

async function _addGroupHappyPath() {
  var ctx = _setup();

  var bidi = await ctx.ss.addGroup({
    slug:  "tshirt-aliases",
    kind:  "bidirectional",
    terms: ["tee", "t-shirt", "tshirt"],
  });
  check("addGroup: returns slug",                   bidi.slug === "tshirt-aliases");
  check("addGroup: returns kind bidirectional",     bidi.kind === "bidirectional");
  check("addGroup: returns terms array",            Array.isArray(bidi.terms) && bidi.terms.length === 3);
  check("addGroup: terms lowercased + trimmed",     bidi.terms.indexOf("t-shirt") !== -1);
  check("addGroup: stamps created_at",              Number.isInteger(bidi.created_at) && bidi.created_at > 0);
  check("addGroup: created_at == updated_at",       bidi.created_at === bidi.updated_at);

  var dir = await ctx.ss.addGroup({
    slug:  "iphone-canonical",
    kind:  "directional",
    terms: ["i-phone", "iphones", "iphone"],
  });
  check("addGroup: directional kind stored",        dir.kind === "directional");
  check("addGroup: directional terms ordering preserved",
    dir.terms[0] === "i-phone" && dir.terms[2] === "iphone");

  // Slug collision is refused
  await assert.rejects(
    ctx.ss.addGroup({ slug: "tshirt-aliases", kind: "bidirectional", terms: ["a", "b"] }),
    /slug already exists/
  );
}

async function _addGroupRefusals() {
  var ctx = _setup();

  await assert.rejects(ctx.ss.addGroup(),                                                  /input object required/);
  await assert.rejects(ctx.ss.addGroup({}),                                                /slug must be/);
  await assert.rejects(ctx.ss.addGroup({ slug: "BadCaps", kind: "bidirectional",
    terms: ["a", "b"] }),                                                                  /slug must match/);
  await assert.rejects(ctx.ss.addGroup({ slug: "9-starts-with-digit", kind: "bidirectional",
    terms: ["a", "b"] }),                                                                  /slug must match/);
  await assert.rejects(ctx.ss.addGroup({ slug: "ok", kind: "junk", terms: ["a", "b"] }),   /kind must be/);
  await assert.rejects(ctx.ss.addGroup({ slug: "ok", kind: "bidirectional",
    terms: ["solo"] }),                                                                    /at least 2/);
  await assert.rejects(ctx.ss.addGroup({ slug: "ok", kind: "bidirectional",
    terms: ["dup", "dup"] }),                                                              /duplicates/);
  await assert.rejects(ctx.ss.addGroup({ slug: "ok", kind: "bidirectional",
    terms: ["good", "bad\nterm"] }),                                                       /control bytes/);
  // 65-char term refused
  var huge = new Array(66).join("x");
  await assert.rejects(ctx.ss.addGroup({ slug: "ok", kind: "bidirectional",
    terms: [huge, "ok"] }),                                                                /<= 64/);
  // 33 terms refused
  var many = [];
  for (var i = 0; i < 33; i += 1) many.push("t" + i);
  await assert.rejects(ctx.ss.addGroup({ slug: "ok", kind: "bidirectional", terms: many }), /<= 32/);
  // Zero-width term refused (U+200B = ZWSP between letters)
  await assert.rejects(ctx.ss.addGroup({ slug: "ok", kind: "bidirectional",
    terms: ["good", "a​b"] }),                                                        /zero-width/);
}

async function _typosAndStopwords() {
  var ctx = _setup();

  await ctx.ss.addTypo({ misspelling: "  WIDGT  ", correction: "widget" });
  await ctx.ss.addTypo({ misspelling: "TELEFONE",  correction: "telephone" });
  var typos = await ctx.ss.listTypos({});
  check("listTypos: returns both rows",          typos.length === 2);
  check("listTypos: misspelling lowercased",     typos.some(function (t) { return t.misspelling === "widgt" && t.correction === "widget"; }));

  // Re-author the same misspelling — upsert
  await ctx.ss.addTypo({ misspelling: "widgt", correction: "gadget" });
  var refreshed = await ctx.ss.listTypos({});
  check("addTypo: upsert overwrites correction", refreshed.some(function (t) { return t.misspelling === "widgt" && t.correction === "gadget"; }));
  check("addTypo: count stays at 2",             refreshed.length === 2);

  await assert.rejects(ctx.ss.addTypo({ misspelling: "same", correction: "same" }), /must differ/);
  await assert.rejects(ctx.ss.addTypo({ misspelling: "", correction: "x" }),         /misspelling must be/);
  await assert.rejects(ctx.ss.addTypo({}),                                            /misspelling must be/);

  await ctx.ss.addStopword("The");
  await ctx.ss.addStopword("of");
  await ctx.ss.addStopword("of");                              // idempotent
  var sw = await ctx.ss.listStopwords({});
  check("listStopwords: returns 2 rows (idempotent insert)", sw.length === 2);
  check("listStopwords: lowercased",                          sw.some(function (s) { return s.word === "the"; }));

  var removed = await ctx.ss.removeStopword("the");
  check("removeStopword: returned true on hit",  removed.removed === true);
  var removedAgain = await ctx.ss.removeStopword("the");
  check("removeStopword: returned false on miss", removedAgain.removed === false);

  await assert.rejects(ctx.ss.addStopword(""), /word must be/);
}

async function _crudGroups() {
  var ctx = _setup();
  var added = await ctx.ss.addGroup({
    slug: "colors-blue", kind: "bidirectional", terms: ["azure", "cobalt", "navy"],
  });
  var got = await ctx.ss.getGroup("colors-blue");
  check("getGroup: returns the row",     got !== null && got.slug === "colors-blue");
  check("getGroup: terms hydrated",      got.terms.length === 3);

  var missing = await ctx.ss.getGroup("does-not-exist");
  check("getGroup: returns null on miss", missing === null);

  // Update — change kind + terms
  var updated = await ctx.ss.updateGroup("colors-blue", {
    kind:  "directional",
    terms: ["azure", "cobalt", "blue"],
  });
  check("updateGroup: kind patched",      updated.kind === "directional");
  check("updateGroup: terms patched",     updated.terms[2] === "blue");
  check("updateGroup: updated_at advances", updated.updated_at >= added.updated_at);

  // Empty patch refused
  await assert.rejects(ctx.ss.updateGroup("colors-blue", {}), /no updatable fields/);

  // Unknown slug returns null
  var miss = await ctx.ss.updateGroup("nope", { kind: "directional" });
  check("updateGroup: returns null for unknown slug", miss === null);

  await ctx.ss.addGroup({ slug: "g-a", kind: "bidirectional",  terms: ["a1", "a2"] });
  await ctx.ss.addGroup({ slug: "g-b", kind: "directional",    terms: ["b1", "b2", "b3"] });
  var listed = await ctx.ss.listGroups({});
  check("listGroups: returns all rows",        listed.length === 3);
  var dirOnly = await ctx.ss.listGroups({ kind: "directional" });
  check("listGroups: kind filter applied",     dirOnly.length === 2);

  var del = await ctx.ss.deleteGroup("colors-blue");
  check("deleteGroup: removed=true on hit",    del.removed === true);
  var delAgain = await ctx.ss.deleteGroup("colors-blue");
  check("deleteGroup: removed=false on miss",  delAgain.removed === false);
}

async function _rewriteEndToEnd() {
  var ctx = _setup();
  await ctx.ss.addStopword("the");
  await ctx.ss.addStopword("of");
  await ctx.ss.addTypo({ misspelling: "widgt",   correction: "widget" });
  await ctx.ss.addTypo({ misspelling: "telefone", correction: "telephone" });
  await ctx.ss.addGroup({
    slug: "tshirt-aliases", kind: "bidirectional", terms: ["tee", "t-shirt", "tshirt"],
  });
  await ctx.ss.addGroup({
    slug: "iphone-canonical", kind: "directional", terms: ["i-phone", "iphones", "iphone"],
  });

  // Stopword removal + bidirectional expansion + typo correction
  var r1 = await ctx.ss.rewrite("the BLUE widgt");
  check("rewrite: canonical is lowercased",         r1.canonical.indexOf("blue") !== -1);
  check("rewrite: stopword 'the' removed",          r1.canonical.split(" ").indexOf("the") === -1);
  check("rewrite: typo widgt -> widget",            r1.canonical.indexOf("widget") !== -1);
  check("rewrite: typo recorded in corrections",
    r1.corrections.some(function (c) { return c.from === "widgt" && c.to === "widget" && c.kind === "typo"; }));
  check("rewrite: stopword recorded in corrections",
    r1.corrections.some(function (c) { return c.from === "the" && c.kind === "stopword"; }));

  // Bidirectional expansion — searching for "tshirt" expands to {tee, t-shirt}
  var r2 = await ctx.ss.rewrite("tshirt");
  check("rewrite: bidirectional expansions present",
    r2.expansions.indexOf("tee") !== -1 && r2.expansions.indexOf("t-shirt") !== -1);
  check("rewrite: canonical is the input token",      r2.canonical === "tshirt");

  // Directional expansion — searching for the canonical "iphone" expands
  // to the leading members; searching a leading member expands to the
  // canonical only.
  var r3 = await ctx.ss.rewrite("iphone");
  check("rewrite: directional expansion (canonical -> leading members)",
    r3.expansions.indexOf("i-phone") !== -1 && r3.expansions.indexOf("iphones") !== -1);

  var r4 = await ctx.ss.rewrite("i-phone");
  check("rewrite: directional expansion (leading member -> canonical only)",
    r4.expansions.length === 1 && r4.expansions[0] === "iphone");

  // Stemming — `running` collapses to `runn` is not what we want (we
  // strip `-ing` not `-ning`). Use `walking` -> `walk` and `boxes` ->
  // `box`.
  var r5 = await ctx.ss.rewrite("walking boxes");
  check("rewrite: stemming -ing", r5.canonical.split(" ").indexOf("walk") !== -1);
  check("rewrite: stemming -es",  r5.canonical.split(" ").indexOf("box")  !== -1);

  // include_corrections=false suppresses the diff
  var r6 = await ctx.ss.rewrite("the widgt", { include_corrections: false });
  check("rewrite: include_corrections=false yields empty diff", r6.corrections.length === 0);

  // Empty query after sanitisation
  var r7 = await ctx.ss.rewrite("");
  check("rewrite: empty input yields empty canonical", r7.canonical === "");
  check("rewrite: empty input yields empty expansions", r7.expansions.length === 0);
}

async function _rewriteHostileInput() {
  var ctx = _setup();
  await ctx.ss.addTypo({ misspelling: "widgt", correction: "widget" });
  await ctx.ss.addStopword("the");

  // Control bytes — newline, NUL, BEL — should be stripped, not refused.
  var r1 = await ctx.ss.rewrite("the\x00widgt\nblue\x07");
  check("rewrite: control bytes stripped, query still rewritten",
    r1.canonical.indexOf("widget") !== -1 && r1.canonical.indexOf("blue") !== -1);
  check("rewrite: control-byte query did not leak raw bytes",
    !/[\x00-\x1f\x7f]/.test(r1.canonical));

  // Zero-width / direction-override — stripped from input. The
  // hostile string is assembled from String.fromCharCode so the
  // file stays ESLint no-irregular-whitespace clean; the bytes
  // reach the primitive exactly as if they'd been pasted in raw.
  var ZWSP   = String.fromCharCode(0x200B);  // zero-width space
  var RLO    = String.fromCharCode(0x202E);  // right-to-left override
  var hostile = "blu" + ZWSP + "e wid" + RLO + "get";
  var r2 = await ctx.ss.rewrite(hostile);
  var zwRe = new RegExp("[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]");
  check("rewrite: zero-width chars removed", !zwRe.test(r2.canonical));

  // Oversize query refused (the cap is a different control — refuse,
  // since 500+ chars in a search box is operator-error or attack)
  var huge = new Array(502).join("x");
  await assert.rejects(ctx.ss.rewrite(huge), /<= 500/);

  // Non-string query refused
  await assert.rejects(ctx.ss.rewrite(42), /must be a string/);
}

async function _rewriteMaxExpansionsCap() {
  var ctx = _setup();
  var terms = [];
  for (var i = 0; i < 20; i += 1) terms.push("alias-" + i);
  await ctx.ss.addGroup({ slug: "huge-bidi", kind: "bidirectional", terms: terms });

  var unlimited = await ctx.ss.rewrite("alias-0");
  check("rewrite: full expansion set surfaces by default", unlimited.expansions.length === 19);

  var capped = await ctx.ss.rewrite("alias-0", { max_expansions: 3 });
  check("rewrite: max_expansions caps the expansion list", capped.expansions.length === 3);

  // Bad cap refused
  await assert.rejects(ctx.ss.rewrite("x", { max_expansions: 0 }),   /max_expansions/);
  await assert.rejects(ctx.ss.rewrite("x", { max_expansions: 1.5 }), /max_expansions/);
  await assert.rejects(ctx.ss.rewrite("x", { max_expansions: 9999 }), /max_expansions/);
}

async function _learnFromQueriesHeuristic() {
  var ctx = _setup();
  var now = Date.now();

  // Seed query log via direct inserts so we don't need the
  // searchSuggestions primitive wired up here. occurred_at falls
  // inside the [from, to] window we'll pass to learnFromQueries.
  async function _logQuery(q, occurredAt) {
    await ctx.query(
      "INSERT INTO search_query_log " +
      "(id, query_normalized, session_id_hash, result_count, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [
        "qid-" + Math.random().toString(36).slice(2, 10) + "-" + occurredAt,
        q, "h", 0, occurredAt,
      ]
    );
  }

  // "running shoes" co-occurs 6 times — over the threshold
  for (var i = 0; i < 6; i += 1) {
    await _logQuery("running shoes", now - 1000 - i);
  }
  // "sneaker shoes" co-occurs 5 times — at the threshold
  for (var j = 0; j < 5; j += 1) {
    await _logQuery("sneaker shoes", now - 2000 - j);
  }
  // "rare pair" co-occurs once — below the threshold
  await _logQuery("rare pair", now - 3000);

  // Pre-seed a group covering ["shoes", "footwear"] — this should NOT
  // prevent ("running", "shoes") suggestion (the pair isn't covered)
  // but a group covering ("running", "shoes") would.
  await ctx.ss.addGroup({
    slug: "footwear-alias", kind: "bidirectional", terms: ["shoes", "footwear"],
  });

  var sug = await ctx.ss.learnFromQueries({
    from: now - 10000, to: now + 1000, min_count: 5,
  });
  check("learnFromQueries: returns at least 2 suggestions", sug.length >= 2);
  check("learnFromQueries: sorted by count desc",
    sug[0].count >= sug[sug.length - 1].count);
  check("learnFromQueries: top suggestion is running+shoes",
    sug[0].terms.indexOf("running") !== -1 && sug[0].terms.indexOf("shoes") !== -1 && sug[0].count === 6);
  check("learnFromQueries: rare pair excluded by min_count",
    !sug.some(function (s) { return s.terms.indexOf("rare") !== -1; }));

  // Now add a group covering (running, shoes) — the next learn pass
  // should drop the pair as already covered.
  await ctx.ss.addGroup({
    slug: "running-shoes", kind: "bidirectional", terms: ["running", "shoes"],
  });
  var sug2 = await ctx.ss.learnFromQueries({
    from: now - 10000, to: now + 1000, min_count: 5,
  });
  check("learnFromQueries: covered pairs excluded",
    !sug2.some(function (s) {
      return s.terms.indexOf("running") !== -1 && s.terms.indexOf("shoes") !== -1;
    }));

  // Bad inputs refused
  await assert.rejects(ctx.ss.learnFromQueries(),                                   /input object required/);
  await assert.rejects(ctx.ss.learnFromQueries({ from: 1, to: 0 }),                 /to must be/);
  await assert.rejects(ctx.ss.learnFromQueries({ from: -1, to: 100 }),              /from must be/);
  await assert.rejects(ctx.ss.learnFromQueries({ from: 0, to: 100, min_count: 0 }), /min_count/);
  await assert.rejects(ctx.ss.learnFromQueries({ from: 0, to: 100, min_count: 1.5 }), /min_count/);
}

async function _cacheInvalidatesOnMutation() {
  var ctx = _setup();

  // First rewrite — no rules, canonical is just the tokenised input.
  var before = await ctx.ss.rewrite("tee shirt");
  check("rewrite: pre-mutation canonical has both tokens",
    before.canonical === "tee shirt" && before.expansions.length === 0);

  // Add a synonym group — the next rewrite must reflect it.
  await ctx.ss.addGroup({
    slug: "tee-shirt-aliases", kind: "bidirectional", terms: ["tee", "t-shirt"],
  });
  var after = await ctx.ss.rewrite("tee");
  check("rewrite: post-mutation expansion reflects new group",
    after.expansions.indexOf("t-shirt") !== -1);

  // Add a stopword — next rewrite drops it.
  await ctx.ss.addStopword("the");
  var afterStop = await ctx.ss.rewrite("the tee");
  check("rewrite: post-mutation stopword drop applied",
    afterStop.canonical.split(" ").indexOf("the") === -1);
}

async function run() {
  await _addGroupHappyPath();
  await _addGroupRefusals();
  await _typosAndStopwords();
  await _crudGroups();
  await _rewriteEndToEnd();
  await _rewriteHostileInput();
  await _rewriteMaxExpansionsCap();
  await _learnFromQueriesHeuristic();
  await _cacheInvalidatesOnMutation();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK — " + helpers.getChecks() + " check(s) passed");
  }, function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
