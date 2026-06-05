"use strict";
/**
 * Search ranking — edge / container parity.
 *
 * The storefront /search page reranks the matched product set through the
 * operator's active weight set + manual pins in BOTH substrates: the container
 * drives the canonical `lib/search-ranking.js` primitive (`applyToResults`);
 * the Cloudflare Worker can't `require` a CommonJS leaf, so it mirrors the same
 * scoring + pin + sort algorithm in `worker/data/search-ranking.js` (ESM). If
 * the two drift, an operator who tunes ranking sees it on logged-in traffic
 * (served by the container) but anonymous traffic (served at the edge) gets a
 * different order for the same query.
 *
 * This test pins the edge mirror to the lib output: the same projected rows +
 * the same active weights + the same pins through both rankers must yield the
 * SAME result order (by product_id). Pure functions only — no DB, no HTTP. The
 * lib side runs `applyToResults` against an in-memory query stub; the edge side
 * runs `applyRanking` over the weights/pins the stub stored. The ESM mirror is
 * loaded via dynamic `import()`.
 *
 * DEPLOY-BRICKER: this test imports worker/data/search-ranking.js, which is
 * EXCLUDED from the container build context (.dockerignore). The
 * fs.existsSync(edgePath) guard + early return BEFORE the import() is
 * mandatory — an unguarded worker import fails the in-image
 * `RUN node test/smoke.js`, fails the Docker build, and bricks every container
 * deploy. Copied from search-faceting-parity.test.js.
 */

var path   = require("node:path");
var assert = require("node:assert");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

// In-memory query stub for the lib `searchRanking` primitive — only the
// tables `defineWeights` / `setActiveWeights` / `pinProductForQuery` /
// `applyToResults` touch are modelled, so the lib runs without a real DB.
function _memQuery() {
  var weightSets = {}; // slug -> row
  var pins = {};       // (query + " " + product_id) -> row
  return async function (sql, params) {
    params = params || [];
    var s = sql.replace(/\s+/g, " ").trim();

    // ---- search_weight_sets ----
    if (/^INSERT INTO search_weight_sets /.test(s)) {
      weightSets[params[0]] = {
        slug: params[0], name: params[1], weights_json: params[2],
        active: 0, archived_at: null, created_at: params[3], updated_at: params[3],
      };
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE search_weight_sets SET name = /.test(s)) {
      var ru = weightSets[params[3]];
      if (ru) { ru.name = params[0]; ru.weights_json = params[1]; ru.updated_at = params[2]; }
      return { rows: [], rowCount: ru ? 1 : 0 };
    }
    if (/^UPDATE search_weight_sets SET active = 0/.test(s)) {
      // params: [ts, slug-to-keep]
      var changed = 0;
      Object.keys(weightSets).forEach(function (k) {
        if (weightSets[k].active === 1 && weightSets[k].slug !== params[1]) {
          weightSets[k].active = 0; weightSets[k].updated_at = params[0]; changed += 1;
        }
      });
      return { rows: [], rowCount: changed };
    }
    if (/^UPDATE search_weight_sets SET active = 1/.test(s)) {
      var ra = weightSets[params[1]];
      if (ra) { ra.active = 1; ra.updated_at = params[0]; }
      return { rows: [], rowCount: ra ? 1 : 0 };
    }
    if (/FROM search_weight_sets WHERE slug = /.test(s)) {
      var wr = weightSets[params[0]];
      return { rows: wr ? [wr] : [], rowCount: wr ? 1 : 0 };
    }
    if (/FROM search_weight_sets WHERE active = 1 AND archived_at IS NULL/.test(s)) {
      var active = Object.keys(weightSets)
        .map(function (k) { return weightSets[k]; })
        .filter(function (r) { return r.active === 1 && r.archived_at == null; })
        .sort(function (a, b) {
          if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
          return a.slug < b.slug ? -1 : (a.slug > b.slug ? 1 : 0);
        });
      return { rows: active.length ? [active[0]] : [], rowCount: active.length ? 1 : 0 };
    }

    // ---- search_manual_pins ----
    if (/^INSERT INTO search_manual_pins /.test(s)) {
      var key = params[0] + " " + params[1];
      pins[key] = { query: params[0], product_id: params[1], position: params[2], created_at: params[3], updated_at: params[3] };
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT created_at FROM search_manual_pins WHERE query = /.test(s)) {
      var keyR = params[0] + " " + params[1];
      var pr = pins[keyR];
      return { rows: pr ? [{ created_at: pr.created_at }] : [], rowCount: pr ? 1 : 0 };
    }
    if (/FROM search_manual_pins WHERE query = \?1 AND product_id = /.test(s)) {
      var keyS = params[0] + " " + params[1];
      var prS = pins[keyS];
      return { rows: prS ? [prS] : [], rowCount: prS ? 1 : 0 };
    }
    if (/FROM search_manual_pins WHERE query = \?1 ORDER BY position/.test(s)) {
      var forQuery = Object.keys(pins)
        .map(function (k) { return pins[k]; })
        .filter(function (r) { return r.query === params[0]; })
        .sort(function (a, b) {
          if (a.position !== b.position) return a.position - b.position;
          return a.created_at - b.created_at;
        });
      return { rows: forQuery, rowCount: forQuery.length };
    }
    return { rows: [], rowCount: 0 };
  };
}

// Project a fixture row the same way both substrates do (id -> product_id +
// the in_stock/price_minor signal bag). Shared by the lib + edge calls so the
// only thing under test is the scoring + pin + sort.
function _project(row) {
  return Object.assign({}, row, {
    product_id: row.id,
    signals: {
      in_stock: row.in_stock === true,
      price_minor: (typeof row.price_minor === "number" && isFinite(row.price_minor)) ? row.price_minor : 0,
    },
  });
}

function _order(rows) {
  return rows.map(function (r) { return r.product_id; });
}

function _clone(rows) {
  return rows.map(function (r) { return Object.assign({}, r); });
}

async function _run() {
  // worker/ is excluded from the container build context (.dockerignore), so
  // worker/data/search-ranking.js isn't present in the in-image smoke gate.
  // Skip the parity there; it's covered by the full-tree CI run where worker/
  // IS present. A worker-importing test left unguarded fails the in-image
  // `RUN node test/smoke.js`, which fails the Docker build and blocks every
  // container deploy.
  var fs = require("node:fs");
  var edgePath = path.resolve(__dirname, "..", "..", "worker", "data", "search-ranking.js");
  if (!fs.existsSync(edgePath)) return;
  var edge = await import("file://" + edgePath.replace(/\\/g, "/"));

  // Fixture: four products with distinct in_stock + price signals so a weight
  // set reorders them non-trivially and ties exercise the product_id ASC
  // tiebreak (alpha + gamma share both signals).
  var ROWS = [
    { id: "alpha", title: "Alpha", in_stock: true,  price_minor: 1999 },
    { id: "bravo", title: "Bravo", in_stock: false, price_minor: 4999 },
    { id: "delta", title: "Delta", in_stock: true,  price_minor: 8999 },
    { id: "gamma", title: "Gamma", in_stock: true,  price_minor: 1999 },
  ];
  var PROJECTED = ROWS.map(_project);

  // Weight sets defined + activated through the lib primitive so the edge
  // reads the SAME stored weights JSON.
  var WEIGHT_CASES = [
    { slug: "instock-first",      weights: { in_stock: 1000 } },
    { slug: "expensive-first",    weights: { price_minor: 1 } },
    { slug: "instock-then-price", weights: { in_stock: 100000, price_minor: 1 } },
  ];

  // ---- weights-only parity (no pins) ----
  for (var w = 0; w < WEIGHT_CASES.length; w += 1) {
    var wc = WEIGHT_CASES[w];
    var q = _memQuery();
    var lib = bShop.searchRanking.create({ query: q });
    await lib.defineWeights({ slug: wc.slug, name: wc.slug, weights: wc.weights });
    await lib.setActiveWeights(wc.slug);

    var libOrdered = _order(await lib.applyToResults({ query: "summer dress", results: _clone(PROJECTED) }));

    // Edge: rerank the SAME projected rows under the active weights (no pins).
    var active = await lib.activeWeights();
    var edgeOrdered = _order(edge.applyRanking(active.weights, [], _clone(PROJECTED)));

    assert.deepStrictEqual(edgeOrdered, libOrdered, "weights parity (" + wc.slug + ")");
    check("ranking parity weights (" + wc.slug + ")", true);
  }

  // ---- pins-override parity ----
  // Pin two products to fixed positions for a query; pinned rows must lift to
  // the front in pin order on BOTH sides regardless of their weighted score.
  var qp = _memQuery();
  var libP = bShop.searchRanking.create({ query: qp });
  await libP.defineWeights({ slug: "instock-first", name: "instock-first", weights: { in_stock: 1000 } });
  await libP.setActiveWeights("instock-first");
  // bravo is out-of-stock (would rank last unpinned); pin it to slot 1.
  await libP.pinProductForQuery({ query: "Summer Dress", product_id: "bravo", position: 1 });
  // Same normalised query ("summer  dress" collapses to "summer dress").
  await libP.pinProductForQuery({ query: "summer  dress", product_id: "delta", position: 2 });

  var libPinOrdered = _order(await libP.applyToResults({ query: "Summer Dress", results: _clone(PROJECTED) }));

  var activeP = await libP.activeWeights();
  var pinsP = await libP.pinsForQuery("Summer Dress");
  var edgePinOrdered = _order(edge.applyRanking(activeP.weights, pinsP, _clone(PROJECTED)));

  assert.deepStrictEqual(edgePinOrdered, libPinOrdered, "pins-override parity");
  check("ranking parity pins-override", true);
  // Sanity: the pinned products genuinely lead (proves pins fired, not a
  // coincidental score order).
  check("ranking parity pins lead the list", edgePinOrdered[0] === "bravo" && edgePinOrdered[1] === "delta");

  // ---- no-active-weights no-op parity ----
  // With no active weight set and no pins, BOTH sides preserve input order.
  var qn = _memQuery();
  var libN = bShop.searchRanking.create({ query: qn });
  var libNoOp = _order(await libN.applyToResults({ query: "anything", results: _clone(PROJECTED) }));
  var edgeNoOp = _order(edge.applyRanking({}, [], _clone(PROJECTED)));
  assert.deepStrictEqual(edgeNoOp, libNoOp, "no-op (no weights/pins) parity");
  assert.deepStrictEqual(edgeNoOp, _order(PROJECTED), "no-op preserves input order");
  check("ranking parity no-op preserves order", true);

  // ---- ranking-applied at the edge (standalone behaviour) ----
  // Beyond parity, prove the edge ranker actually reorders: in-stock-first
  // must put the out-of-stock bravo LAST, and price weight must lead with the
  // most expensive (delta, $89.99).
  var edgeInStock = _order(edge.applyRanking({ in_stock: 1000 }, [], _clone(PROJECTED)));
  check("edge ranking lifts in-stock above out-of-stock", edgeInStock[edgeInStock.length - 1] === "bravo");
  var edgePrice = _order(edge.applyRanking({ price_minor: 1 }, [], _clone(PROJECTED)));
  check("edge ranking sorts by price DESC", edgePrice[0] === "delta");

  // ---- query normaliser: hostile input degrades to no pins, never throws ----
  // Built with String.fromCharCode so the source file stays clean ASCII (no
  // raw control / zero-width bytes to trip eslint or a byte-grep).
  var TAB = String.fromCharCode(9);
  var ZWSP = String.fromCharCode(0x200B);
  check("normalizeRankingQuery collapses case + whitespace",
    edge.normalizeRankingQuery("  Summer   Dress  ") === "summer dress");
  check("normalizeRankingQuery rejects control bytes (tab)",
    edge.normalizeRankingQuery("a" + TAB + "b") === null);
  check("normalizeRankingQuery rejects zero-width",
    edge.normalizeRankingQuery("a" + ZWSP + "b") === null);
  check("normalizeRankingQuery rejects empty after trim",
    edge.normalizeRankingQuery("   ") === null);
  check("normalizeRankingQuery rejects non-string",
    edge.normalizeRankingQuery(null) === null);

  // ---- projectForRanking parity with the inline projection ----
  var edgeProjected = edge.projectForRanking(ROWS);
  assert.deepStrictEqual(
    edgeProjected.map(function (r) { return { product_id: r.product_id, signals: r.signals }; }),
    PROJECTED.map(function (r) { return { product_id: r.product_id, signals: r.signals }; }),
    "projectForRanking matches the container projection"
  );
  check("ranking parity projectForRanking shape", true);
}

module.exports = { run: _run };
