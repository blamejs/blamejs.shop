"use strict";
/**
 * search-ranking — operator-tunable storefront search reranking.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * `0167_search_ranking.sql`. The primitive isn't wired through
 * `bShop` yet — the test requires `lib/search-ranking.js` directly
 * so the gate exists ahead of the entry-point edit.
 *
 * Coverage:
 *   - defineWeights persists + re-defines in place; archived sets
 *     refuse re-define under the same slug
 *   - setActiveWeights flips the unique-active invariant; activeWeights
 *     returns the live set
 *   - applyToResults: weighted score sort with deterministic
 *     product_id tiebreak; signals can live in `signals` or top-level;
 *     missing signals contribute zero; archived weight set refused
 *   - pinProductForQuery overrides the score sort; pins come first in
 *     position order regardless of score
 *   - pinProductForQuery normalises queries (case + whitespace) so
 *     "Summer Dress" and "  summer dress " hit the same pin set;
 *     unpinProduct round-trips
 *   - recordSearchEvent appends rows; metricsForWeights computes CTR
 *     + conversion + click-to-purchase with null on zero denominators
 *   - input refusals on every public surface
 *   - listWeights / archiveWeights round-trip
 *   - session_id is namespaceHashed; raw value never lands on disk
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var searchRanking = require("../../lib/search-ranking");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

void bShop;   // touch the entry point so the require cycle is exercised

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0167_search_ranking.sql"
);

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
  var q = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
        changes:   Number(info.changes),
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  q.db = db;
  return q;
}

function _setup() {
  var q = _makeQuery();
  var sr = searchRanking.create({ query: q });
  return { query: q, sr: sr };
}

async function _defineWeightsAndActiveFlip() {
  var ctx = _setup();

  // First weight set persists.
  var ws1 = await ctx.sr.defineWeights({
    slug:    "relevance-first",
    name:    "Relevance-weighted",
    weights: { relevance: 1.0, popularity: 0.3, in_stock: 0.2 },
  });
  check("defineWeights returns slug",          ws1.slug === "relevance-first");
  check("defineWeights returns name",          ws1.name === "Relevance-weighted");
  check("defineWeights hydrates weights map",  ws1.weights.relevance === 1.0 && ws1.weights.popularity === 0.3);
  check("defineWeights defaults inactive",     ws1.active === false);
  check("defineWeights sets created_at",       typeof ws1.created_at === "number" && ws1.created_at > 0);
  check("defineWeights sets updated_at",       ws1.updated_at >= ws1.created_at);
  check("defineWeights archived_at null",      ws1.archived_at === null);

  // Re-define same slug replaces in place; created_at preserved.
  var ws1Prime = await ctx.sr.defineWeights({
    slug:    "relevance-first",
    name:    "Relevance-weighted (v2)",
    weights: { relevance: 1.0, popularity: 0.5, in_stock: 0.2, margin: 0.1 },
  });
  check("re-define preserves created_at",       ws1Prime.created_at === ws1.created_at);
  check("re-define bumps updated_at",           ws1Prime.updated_at >= ws1.updated_at);
  check("re-define overwrites name",            ws1Prime.name === "Relevance-weighted (v2)");
  check("re-define overwrites weights",         ws1Prime.weights.popularity === 0.5 && ws1Prime.weights.margin === 0.1);

  // Second set with different weights.
  var ws2 = await ctx.sr.defineWeights({
    slug:    "margin-heavy",
    name:    "Margin-weighted",
    weights: { relevance: 0.5, margin: 1.0 },
  });
  check("second weight set persists",           ws2.slug === "margin-heavy");

  // No active set yet.
  var none = await ctx.sr.activeWeights();
  check("activeWeights returns null when none active", none === null);

  // setActiveWeights flips the live set.
  var active1 = await ctx.sr.setActiveWeights("relevance-first");
  check("setActiveWeights flips slug active",   active1.active === true && active1.slug === "relevance-first");
  var live1 = await ctx.sr.activeWeights();
  check("activeWeights returns live set",       live1.slug === "relevance-first");

  // Flip to other set — prior set clears.
  await ctx.sr.setActiveWeights("margin-heavy");
  var live2 = await ctx.sr.activeWeights();
  check("activeWeights tracks the latest flip", live2.slug === "margin-heavy");
  var allSets = await ctx.sr.listWeights();
  var activeCount = allSets.filter(function (s) { return s.active; }).length;
  check("exactly one active set after flip",    activeCount === 1);

  // Archive — set leaves active; archive sticks.
  var archived = await ctx.sr.archiveWeights("margin-heavy");
  check("archiveWeights returns archived_at",   typeof archived.archived_at === "number");
  check("archiveWeights clears active",         archived.active === false);
  // Re-archive is idempotent.
  var archivedAgain = await ctx.sr.archiveWeights("margin-heavy");
  check("re-archive idempotent",                archivedAgain.archived_at === archived.archived_at);
  // listWeights default hides archived.
  var visibleSets = await ctx.sr.listWeights();
  check("listWeights hides archived by default", visibleSets.every(function (s) { return s.slug !== "margin-heavy"; }));
  var allWithArchived = await ctx.sr.listWeights({ include_archived: true });
  check("listWeights include_archived shows tombstones",
    allWithArchived.some(function (s) { return s.slug === "margin-heavy" && s.archived_at != null; }));

  // Archived set refuses re-define + setActive.
  await assert.rejects(ctx.sr.defineWeights({
    slug: "margin-heavy", name: "X", weights: { relevance: 1.0 },
  }), /archived/);
  await assert.rejects(ctx.sr.setActiveWeights("margin-heavy"), /archived/);

  // Refusals on defineWeights.
  await assert.rejects(ctx.sr.defineWeights(),                                                          /input object required/);
  await assert.rejects(ctx.sr.defineWeights({ slug: "BAD CAPS", name: "X", weights: { relevance: 1 } }), /slug/);
  await assert.rejects(ctx.sr.defineWeights({ slug: "ok", name: "", weights: { relevance: 1 } }),       /name/);
  await assert.rejects(ctx.sr.defineWeights({ slug: "ok", name: "X", weights: {} }),                    /at least one signal/);
  await assert.rejects(ctx.sr.defineWeights({ slug: "ok", name: "X", weights: { "BAD": 1 } }),          /signal name/);
  await assert.rejects(ctx.sr.defineWeights({ slug: "ok", name: "X", weights: { relevance: "high" } }), /finite number/);
  await assert.rejects(ctx.sr.defineWeights({ slug: "ok", name: "X", weights: { relevance: Infinity } }), /finite number/);
  // Control byte in name.
  await assert.rejects(ctx.sr.defineWeights({
    slug: "ok", name: "bad\nname", weights: { relevance: 1 },
  }), /name/);

  // setActiveWeights refusals.
  await assert.rejects(ctx.sr.setActiveWeights("no-such-slug"), /not found/);
  await assert.rejects(ctx.sr.setActiveWeights("BAD CAPS"),     /slug/);
}

async function _applyToResultsScoring() {
  var ctx = _setup();
  await ctx.sr.defineWeights({
    slug: "popularity-led", name: "Popularity-led",
    weights: { popularity: 1.0, recency: 0.5, in_stock: 0.3 },
  });
  await ctx.sr.setActiveWeights("popularity-led");

  // Three candidate results — popularity-heavy, recency-heavy,
  // in-stock-only. Mix signals across top-level + nested `signals`
  // to confirm both surfaces feed the scorer.
  var results = [
    { product_id: "SKU-A", signals: { popularity: 10, recency: 0, in_stock: true  } },  // 10*1 + 0*0.5 + 1*0.3 = 10.3
    { product_id: "SKU-B", popularity: 4, recency: 8, in_stock: false },                 // 4*1 + 8*0.5 + 0*0.3 = 8
    { product_id: "SKU-C", signals: { popularity: 6, recency: 2 }, in_stock: true },     // 6*1 + 2*0.5 + 1*0.3 = 7.3
    { product_id: "SKU-D" },                                                              // no signals → 0
  ];
  var ranked = await ctx.sr.applyToResults({ query: "shoes", results: results });
  check("applyToResults returns same length",       ranked.length === 4);
  check("applyToResults #1 is highest score",        ranked[0].product_id === "SKU-A" && Math.abs(ranked[0]._score - 10.3) < 1e-9);
  check("applyToResults #2",                         ranked[1].product_id === "SKU-B" && ranked[1]._score === 8);
  check("applyToResults #3",                         ranked[2].product_id === "SKU-C" && Math.abs(ranked[2]._score - 7.3) < 1e-9);
  check("applyToResults #4 is zero-signal row",      ranked[3].product_id === "SKU-D" && ranked[3]._score === 0);
  check("applyToResults preserves original fields",  ranked[0].signals && ranked[0].signals.popularity === 10);
  check("applyToResults marks _pinned false",        ranked.every(function (r) { return r._pinned === false; }));

  // Explicit weights_slug bypasses the active set.
  await ctx.sr.defineWeights({
    slug: "recency-led", name: "Recency-led",
    weights: { popularity: 0.1, recency: 5.0 },
  });
  var rankedRecency = await ctx.sr.applyToResults({
    query:         "shoes",
    results:       results,
    weights_slug:  "recency-led",
  });
  // With recency*5: SKU-A=10*0.1+0=1, SKU-B=4*0.1+8*5=40.4, SKU-C=6*0.1+2*5=10.6, SKU-D=0
  check("explicit weights_slug overrides active set", rankedRecency[0].product_id === "SKU-B");
  check("recency-led puts SKU-C above SKU-A",         rankedRecency[1].product_id === "SKU-C");

  // Score tiebreak — two results with identical score sort by
  // product_id ASC.
  var tieResults = [
    { product_id: "ZZZ", signals: { popularity: 1 } },
    { product_id: "AAA", signals: { popularity: 1 } },
    { product_id: "MMM", signals: { popularity: 1 } },
  ];
  var tieRanked = await ctx.sr.applyToResults({ results: tieResults });
  check("tie tiebreak is product_id ASC",  tieRanked[0].product_id === "AAA" && tieRanked[1].product_id === "MMM" && tieRanked[2].product_id === "ZZZ");

  // No active set + no slug → original order preserved with _score = 0.
  var ctx2 = _setup();
  var noWeights = await ctx2.sr.applyToResults({
    results: [
      { product_id: "FIRST",  signals: { popularity: 99 } },
      { product_id: "SECOND", signals: { popularity: 1  } },
    ],
  });
  // Both score 0 so sort by product_id ASC: FIRST < SECOND.
  check("no-active-set yields zero scores",  noWeights.every(function (r) { return r._score === 0; }));
  check("no-active-set sorts deterministically", noWeights[0].product_id === "FIRST");

  // Empty result list returns empty array.
  var empty = await ctx.sr.applyToResults({ results: [] });
  check("applyToResults empty roster returns []", Array.isArray(empty) && empty.length === 0);

  // Boolean signals coerce to 1/0 — test in_stock = false contributes 0 (already covered above).
  // Refusals.
  await assert.rejects(ctx.sr.applyToResults(),                                               /input object required/);
  await assert.rejects(ctx.sr.applyToResults({ results: "not-array" }),                        /results must be an array/);
  await assert.rejects(ctx.sr.applyToResults({ results: [{ /* no product_id */ }] }),          /product_id/);
  await assert.rejects(ctx.sr.applyToResults({ results: [{ product_id: "bad space" }] }),      /product_id/);
  await assert.rejects(ctx.sr.applyToResults({ results: [{ product_id: "ok" }], query: "" }),  /query/);
  await assert.rejects(ctx.sr.applyToResults({ results: [{ product_id: "ok" }], query: "ok", weights_slug: "no-such" }), /not found/);

  // Oversized roster refused.
  var giant = [];
  for (var i = 0; i < 1001; i += 1) giant.push({ product_id: "SKU-" + i });
  await assert.rejects(ctx.sr.applyToResults({ results: giant }), /<= 1000 entries/);
}

async function _manualPinsOverride() {
  var ctx = _setup();
  await ctx.sr.defineWeights({
    slug: "test-weights", name: "Test", weights: { popularity: 1.0 },
  });
  await ctx.sr.setActiveWeights("test-weights");

  // Pin two products for "summer dress" — SKU-LOW at position 1,
  // SKU-MID at position 2.
  var pin1 = await ctx.sr.pinProductForQuery({
    query: "Summer Dress", product_id: "SKU-LOW", position: 1,
  });
  check("pinProductForQuery normalises query",   pin1.query === "summer dress");
  check("pinProductForQuery returns position",   pin1.position === 1);

  await ctx.sr.pinProductForQuery({
    query: "summer dress", product_id: "SKU-MID", position: 2,
  });

  // Whitespace-variant query hits the same pin set.
  var pinsViaWhitespace = await ctx.sr.pinsForQuery("  summer  dress  ");
  check("pinsForQuery normalises whitespace",    pinsViaWhitespace.length === 2);
  check("pinsForQuery sorts by position ASC",    pinsViaWhitespace[0].product_id === "SKU-LOW" && pinsViaWhitespace[1].product_id === "SKU-MID");

  // Apply with results where SKU-LOW + SKU-MID would have scored
  // dead last; pins lift them to the top.
  var results = [
    { product_id: "SKU-HIGH", signals: { popularity: 100 } },
    { product_id: "SKU-MID",  signals: { popularity: 1   } },
    { product_id: "SKU-LOW",  signals: { popularity: 0   } },
    { product_id: "SKU-MED",  signals: { popularity: 50  } },
  ];
  var ranked = await ctx.sr.applyToResults({ query: "summer dress", results: results });
  check("pinned product at position 1 first",    ranked[0].product_id === "SKU-LOW" && ranked[0]._pinned === true);
  check("pinned product at position 2 second",   ranked[1].product_id === "SKU-MID" && ranked[1]._pinned === true);
  check("unpinned SKU-HIGH (popularity 100) #3", ranked[2].product_id === "SKU-HIGH" && ranked[2]._pinned === false);
  check("unpinned SKU-MED (popularity 50) #4",   ranked[3].product_id === "SKU-MED");

  // Re-pinning replaces position in place.
  await ctx.sr.pinProductForQuery({ query: "summer dress", product_id: "SKU-LOW", position: 5 });
  var pinsAfterRepin = await ctx.sr.pinsForQuery("summer dress");
  var lowPin = pinsAfterRepin.filter(function (p) { return p.product_id === "SKU-LOW"; })[0];
  check("re-pinning replaces position",          lowPin.position === 5);
  // With SKU-LOW now at position 5 and SKU-MID at position 2, SKU-MID
  // wins the higher rendered slot.
  var rerank = await ctx.sr.applyToResults({ query: "summer dress", results: results });
  check("after re-pin SKU-MID is first",         rerank[0].product_id === "SKU-MID");
  check("after re-pin SKU-LOW is second pinned", rerank[1].product_id === "SKU-LOW");

  // unpinProduct removes the entry.
  var unp1 = await ctx.sr.unpinProduct({ query: "summer dress", product_id: "SKU-LOW" });
  check("unpinProduct removed = true on hit",    unp1.removed === true);
  // Second unpin is a no-op.
  var unp2 = await ctx.sr.unpinProduct({ query: "summer dress", product_id: "SKU-LOW" });
  check("unpinProduct removed = false on miss",  unp2.removed === false);
  var pinsAfterUnpin = await ctx.sr.pinsForQuery("summer dress");
  check("pins shrink after unpin",               pinsAfterUnpin.length === 1 && pinsAfterUnpin[0].product_id === "SKU-MID");

  // Pin for a different query doesn't bleed across.
  await ctx.sr.pinProductForQuery({ query: "winter coat", product_id: "SKU-XYZ", position: 1 });
  var summerPins = await ctx.sr.pinsForQuery("summer dress");
  var winterPins = await ctx.sr.pinsForQuery("winter coat");
  check("pins per-query isolated",               summerPins.length === 1 && winterPins.length === 1);
  check("pins keyed by normalised query",        winterPins[0].product_id === "SKU-XYZ");

  // Refusals.
  await assert.rejects(ctx.sr.pinProductForQuery(),                                                                /input object required/);
  await assert.rejects(ctx.sr.pinProductForQuery({ query: "ok", product_id: "ok", position: 0 }),                  /position/);
  await assert.rejects(ctx.sr.pinProductForQuery({ query: "ok", product_id: "ok", position: 1001 }),               /position/);
  await assert.rejects(ctx.sr.pinProductForQuery({ query: "ok", product_id: "bad space", position: 1 }),           /product_id/);
  await assert.rejects(ctx.sr.pinProductForQuery({ query: "", product_id: "ok", position: 1 }),                    /query/);
  await assert.rejects(ctx.sr.pinProductForQuery({ query: "x".repeat(501), product_id: "ok", position: 1 }),       /query/);
  await assert.rejects(ctx.sr.pinProductForQuery({ query: "bad\x00query", product_id: "ok", position: 1 }),        /query/);

  await assert.rejects(ctx.sr.unpinProduct(),                                       /input object required/);
  await assert.rejects(ctx.sr.unpinProduct({ query: "", product_id: "ok" }),         /query/);
  await assert.rejects(ctx.sr.unpinProduct({ query: "ok", product_id: "bad space" }), /product_id/);

  await assert.rejects(ctx.sr.pinsForQuery(""),       /query/);
  await assert.rejects(ctx.sr.pinsForQuery(undefined), /query/);
}

async function _recordSearchEventAndMetrics() {
  var ctx = _setup();
  await ctx.sr.defineWeights({
    slug: "metric-test", name: "Metric test", weights: { popularity: 1.0 },
  });

  var start = Date.now();
  // Two impressions, one click, one purchase.
  var ev1 = await ctx.sr.recordSearchEvent({
    query: "Boots", weights_slug: "metric-test", event_type: "impression",
    product_id: "SKU-1", position: 1, session_id: "session-A",
  });
  check("recordSearchEvent returns occurred_at", typeof ev1.occurred_at === "number");
  check("recordSearchEvent normalises query",    ev1.query === "boots");
  check("recordSearchEvent preserves event_type", ev1.event_type === "impression");

  await ctx.sr.recordSearchEvent({
    query: "boots", weights_slug: "metric-test", event_type: "impression",
    product_id: "SKU-2", position: 2,
  });
  await ctx.sr.recordSearchEvent({
    query: "boots", weights_slug: "metric-test", event_type: "click",
    product_id: "SKU-1", position: 1, session_id: "session-A",
  });
  await ctx.sr.recordSearchEvent({
    query: "boots", weights_slug: "metric-test", event_type: "purchase",
    product_id: "SKU-1", session_id: "session-A",
  });
  var end = Date.now() + 1000;

  var metrics = await ctx.sr.metricsForWeights({
    weights_slug: "metric-test", from: start - 1, to: end,
  });
  check("metrics impressions = 2",  metrics.impressions === 2);
  check("metrics clicks = 1",       metrics.clicks === 1);
  check("metrics purchases = 1",    metrics.purchases === 1);
  check("metrics CTR = 0.5",        Math.abs(metrics.ctr - 0.5) < 1e-9);
  check("metrics conversion_rate = 0.5", Math.abs(metrics.conversion_rate - 0.5) < 1e-9);
  check("metrics click_to_purchase = 1.0", Math.abs(metrics.click_to_purchase - 1.0) < 1e-9);

  // Empty window — every ratio is null (no division by zero).
  var emptyMetrics = await ctx.sr.metricsForWeights({
    weights_slug: "metric-test", from: 1, to: 2,
  });
  check("empty window impressions = 0",        emptyMetrics.impressions === 0);
  check("empty window ctr is null",            emptyMetrics.ctr === null);
  check("empty window conversion_rate is null", emptyMetrics.conversion_rate === null);
  check("empty window click_to_purchase null",  emptyMetrics.click_to_purchase === null);

  // Window with impressions but no clicks/purchases — CTR = 0,
  // click_to_purchase = null (zero denominator on the click side).
  await ctx.sr.defineWeights({
    slug: "no-clicks", name: "No clicks", weights: { popularity: 1.0 },
  });
  await ctx.sr.recordSearchEvent({
    query: "test", weights_slug: "no-clicks", event_type: "impression", product_id: "X",
  });
  var noClickMetrics = await ctx.sr.metricsForWeights({
    weights_slug: "no-clicks", from: start - 1, to: end,
  });
  check("impressions-only CTR = 0",             noClickMetrics.ctr === 0);
  check("impressions-only conversion_rate = 0", noClickMetrics.conversion_rate === 0);
  check("zero-clicks click_to_purchase null",   noClickMetrics.click_to_purchase === null);

  // session_id is hashed; raw value never lands on disk.
  var eventRows = (await ctx.query("SELECT session_id_hash FROM search_events WHERE session_id_hash IS NOT NULL", [])).rows;
  check("event session_id stored as hex sha3 hash",
    eventRows.every(function (r) { return typeof r.session_id_hash === "string" && /^[0-9a-f]{128}$/.test(r.session_id_hash); }));
  check("event session_id raw never on disk",
    eventRows.every(function (r) { return r.session_id_hash.indexOf("session-") === -1; }));

  // Two weight sets — metrics are siloed per slug.
  await ctx.sr.defineWeights({
    slug: "set-a", name: "Set A", weights: { popularity: 1.0 },
  });
  await ctx.sr.defineWeights({
    slug: "set-b", name: "Set B", weights: { popularity: 1.0 },
  });
  await ctx.sr.recordSearchEvent({
    query: "x", weights_slug: "set-a", event_type: "impression", product_id: "P",
  });
  await ctx.sr.recordSearchEvent({
    query: "x", weights_slug: "set-b", event_type: "impression", product_id: "P",
  });
  await ctx.sr.recordSearchEvent({
    query: "x", weights_slug: "set-b", event_type: "click", product_id: "P",
  });
  var metricsA = await ctx.sr.metricsForWeights({ weights_slug: "set-a", from: start - 1, to: Date.now() + 1000 });
  var metricsB = await ctx.sr.metricsForWeights({ weights_slug: "set-b", from: start - 1, to: Date.now() + 1000 });
  check("set-a impressions = 1, clicks = 0",  metricsA.impressions === 1 && metricsA.clicks === 0);
  check("set-b impressions = 1, clicks = 1",  metricsB.impressions === 1 && metricsB.clicks === 1);
  check("set-b CTR = 1.0",                    metricsB.ctr === 1);

  // Refusals.
  await assert.rejects(ctx.sr.recordSearchEvent(),                                                                                /input object required/);
  await assert.rejects(ctx.sr.recordSearchEvent({ query: "ok", weights_slug: "metric-test", event_type: "share" }),                /event_type/);
  await assert.rejects(ctx.sr.recordSearchEvent({ query: "ok", weights_slug: "no-such-slug", event_type: "impression" }),          /not found/);
  await assert.rejects(ctx.sr.recordSearchEvent({ query: "", weights_slug: "metric-test", event_type: "impression" }),             /query/);
  await assert.rejects(ctx.sr.recordSearchEvent({ query: "ok", weights_slug: "metric-test", event_type: "impression", session_id: "" }), /session_id/);
  await assert.rejects(ctx.sr.recordSearchEvent({ query: "ok", weights_slug: "metric-test", event_type: "impression", position: 0 }),   /position/);
  await assert.rejects(ctx.sr.recordSearchEvent({ query: "ok", weights_slug: "metric-test", event_type: "impression", product_id: "bad space" }), /product_id/);

  // metricsForWeights refusals.
  await assert.rejects(ctx.sr.metricsForWeights(),                                                              /input object required/);
  await assert.rejects(ctx.sr.metricsForWeights({ weights_slug: "metric-test", from: -1, to: 10 }),              /from/);
  await assert.rejects(ctx.sr.metricsForWeights({ weights_slug: "metric-test", from: 10, to: 5 }),               /from must be <= to/);
  await assert.rejects(ctx.sr.metricsForWeights({ weights_slug: "no-such",     from: 0,  to: 10 }),              /not found/);
  await assert.rejects(ctx.sr.metricsForWeights({ weights_slug: "BAD CAPS",    from: 0,  to: 10 }),              /slug/);
}

async function _listAndArchiveSurface() {
  var ctx = _setup();
  await ctx.sr.defineWeights({ slug: "alpha", name: "Alpha", weights: { popularity: 1.0 } });
  await ctx.sr.defineWeights({ slug: "beta",  name: "Beta",  weights: { popularity: 1.0 } });
  await ctx.sr.defineWeights({ slug: "gamma", name: "Gamma", weights: { popularity: 1.0 } });
  await ctx.sr.setActiveWeights("beta");

  var listed = await ctx.sr.listWeights();
  check("listWeights returns all 3",                       listed.length === 3);
  check("listWeights active set comes first",              listed[0].slug === "beta" && listed[0].active === true);

  // Limit honoured.
  var first2 = await ctx.sr.listWeights({ limit: 2 });
  check("listWeights honours limit",                       first2.length === 2);

  // Archive one — disappears from default list.
  await ctx.sr.archiveWeights("gamma");
  var afterArchive = await ctx.sr.listWeights();
  check("archived row absent from default listWeights",    afterArchive.every(function (s) { return s.slug !== "gamma"; }));

  // archiveWeights refusals.
  await assert.rejects(ctx.sr.archiveWeights("no-such"), /not found/);
  await assert.rejects(ctx.sr.archiveWeights("BAD CAPS"), /slug/);

  // listWeights refusals.
  await assert.rejects(ctx.sr.listWeights({ limit: 0 }),    /limit/);
  await assert.rejects(ctx.sr.listWeights({ limit: 9999 }), /limit/);
}

async function _catalogPassthrough() {
  // rankQuery only works when a catalog binding is passed to the
  // factory.
  var q = _makeQuery();
  var roster = [
    { product_id: "A", title: "Apple", signals: { popularity: 5 } },
    { product_id: "B", title: "Banana", signals: { popularity: 10 } },
    { product_id: "C", title: "Cherry", signals: { popularity: 1 } },
  ];
  var catalog = {
    list: async function (opts) {
      // Echo back the roster filtered by query substring on title.
      var qs = String((opts || {}).query || "").toLowerCase();
      var rows = roster.filter(function (r) { return r.title.toLowerCase().indexOf(qs) !== -1; });
      return { rows: rows };
    },
  };
  var sr = searchRanking.create({ query: q, catalog: catalog });
  await sr.defineWeights({ slug: "pop", name: "Pop", weights: { popularity: 1.0 } });
  await sr.setActiveWeights("pop");

  var ranked = await sr.rankQuery({ query: "a" });
  // "a" hits Apple + Banana — Banana has popularity 10, Apple 5.
  check("rankQuery composes catalog.list",       ranked.length === 2);
  check("rankQuery ranks by weighted score",     ranked[0].product_id === "B" && ranked[1].product_id === "A");

  // No-catalog instance refuses rankQuery.
  var srNoCatalog = searchRanking.create({ query: q });
  await assert.rejects(srNoCatalog.rankQuery({ query: "x" }), /no catalog binding/);

  // Bad catalog refused at factory time.
  assert.throws(function () { searchRanking.create({ query: q, catalog: {} }); }, /catalog must expose/);
}

async function _monotonicClockDiscipline() {
  var ctx = _setup();
  await ctx.sr.defineWeights({ slug: "clock", name: "Clock", weights: { popularity: 1.0 } });

  // Fire two same-millisecond events; occurred_at must be strictly
  // increasing in the persisted rows.
  await ctx.sr.recordSearchEvent({ query: "x", weights_slug: "clock", event_type: "impression", product_id: "A" });
  await ctx.sr.recordSearchEvent({ query: "x", weights_slug: "clock", event_type: "impression", product_id: "B" });
  await ctx.sr.recordSearchEvent({ query: "x", weights_slug: "clock", event_type: "impression", product_id: "C" });

  var rows = (await ctx.query(
    "SELECT occurred_at FROM search_events ORDER BY occurred_at ASC", []
  )).rows;
  check("three events persisted",            rows.length === 3);
  for (var i = 1; i < rows.length; i += 1) {
    check("monotonic clock — occurred_at[" + i + "] > [" + (i - 1) + "]",
      Number(rows[i].occurred_at) > Number(rows[i - 1].occurred_at));
  }

  // Two same-millisecond pin writes — updated_at strictly increases.
  var p1 = await ctx.sr.pinProductForQuery({ query: "x", product_id: "P1", position: 1 });
  var p2 = await ctx.sr.pinProductForQuery({ query: "x", product_id: "P2", position: 2 });
  check("monotonic clock — pin updated_at strict order", p2.updated_at > p1.updated_at);
}

async function run() {
  await _defineWeightsAndActiveFlip();
  await _applyToResultsScoring();
  await _manualPinsOverride();
  await _recordSearchEventAndMetrics();
  await _listAndArchiveSurface();
  await _catalogPassthrough();
  await _monotonicClockDiscipline();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/search-ranking.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — search-ranking (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — search-ranking: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
