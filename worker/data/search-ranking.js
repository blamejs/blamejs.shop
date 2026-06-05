// Edge-side search ranking — operator-tunable rerank, pure functions + a
// missing-table-resilient D1 read. The storefront /search page reranks the
// matched product set through the operator's active weight set + manual pins
// in BOTH substrates: the container drives the canonical
// `lib/search-ranking.js` primitive (`applyToResults`); the Cloudflare Worker
// can't `require` a CommonJS leaf, so this ESM module mirrors the same scoring
// + pin + sort algorithm against the same flat result-row shape. The
// `search-ranking-parity` layer-1 test pins this mirror to the lib's output so
// the two never drift — an operator who flips EDGE_RENDER on/off (or whose
// anonymous traffic is served at the edge while logged-in traffic hits the
// container) gets the SAME result order for the same query + weights + pins.
//
// Algorithm (byte-for-byte the lib's `applyToResults` minus the storage /
// event-log surface, which is operator-write-side and never runs at the edge):
//
//   1. score each row: `sum_signal( weight[signal] * row.signals[signal] )`.
//      Signals are read from the `signals` bucket first, then top-level keys
//      on the row, then contribute zero. Booleans coerce to 0/1; finite
//      numbers pass through; anything else contributes zero. (mirror of
//      `_scoreResult`).
//   2. split pinned (product_id in the pin set) from unpinned.
//   3. pinned rows sort by pin position ASC, ties by product_id ASC.
//   4. unpinned rows sort by weighted score DESC, ties by product_id ASC.
//   5. concatenate pinned-first so the merchandiser override always wins.
//
// Pins keys (`query`) are normalised the same way the lib normalises at its
// entry point — lowercase + whitespace-collapse + trim — so "Summer Dress" and
// "  summer dross " resolve to the same pin set on both sides. A query that
// carries control / zero-width bytes (which the lib's `_normalizeQuery`
// rejects with a throw) yields `null` here instead — the edge is a read path
// that must never 500 the search page over a hostile query, so it degrades to
// "no pins" rather than throwing. The weighted-score sort still runs, so
// ranking minus pins is the worst-case fallback for such a query.
//
// Edge-cache coherence: /search responses are edge-cached at
// `max-age=60, stale-while-revalidate=300` keyed on the full request URL
// (including `?q=`). The active weight set + pins are read fresh on every
// edge-render MISS, so an operator weight/pin change takes effect on the next
// cache MISS and is fully visible within the same 60s-fresh / 360s-SWR window
// every other operator edge config change uses (announcements, synonyms,
// facets). No bespoke purge is needed — the URL-keyed TTL already bounds the
// staleness, identical to the announcement bar's coherence story.
//
// Missing-table-resilient: the `search_weight_sets` / `search_manual_pins`
// tables may not be migrated on a given deploy (migration
// `0167_search_ranking.sql`). A query that throws "no such table" reads as
// "no active weight set / no pins", so the edge degrades to the un-ranked
// default order rather than 500-ing the page — the same NEVER-500 stance the
// container's `_rerankUniverse` takes.

// Normalise a search query into the pin-set key. Mirror of the lib's
// `_normalizeQuery` minus the throw: a non-string, an over-length query, or a
// query carrying control / zero-width bytes yields `null` (no pins) so the
// edge read path never throws on a hostile query. A query that normalises to
// empty also yields `null`.
var RANKING_MAX_QUERY_LEN = 500;
var RANKING_CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;
var RANKING_ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

export function normalizeRankingQuery(s) {
  if (typeof s !== "string") return null;
  if (s.length > RANKING_MAX_QUERY_LEN) return null;
  if (RANKING_CONTROL_BYTE_RE.test(s) || RANKING_ZERO_WIDTH_RE.test(s)) return null;
  var normalized = s.toLowerCase().replace(/\s+/g, " ").trim();
  return normalized.length ? normalized : null;
}

// Weighted score for a single row against a weight set. Reads each weight's
// signal from the row's `signals` bucket first, then a top-level key on the
// row, then contributes zero. Booleans coerce to 0/1; finite numbers pass
// through; anything else contributes zero. Byte-for-byte the lib's
// `_scoreResult`.
function _scoreResult(result, weights) {
  var signalBag = (result && result.signals && typeof result.signals === "object")
    ? result.signals
    : null;
  var score = 0;
  var keys = Object.keys(weights);
  for (var i = 0; i < keys.length; i += 1) {
    var k = keys[i];
    var raw;
    if (signalBag && Object.prototype.hasOwnProperty.call(signalBag, k)) {
      raw = signalBag[k];
    } else if (result && Object.prototype.hasOwnProperty.call(result, k)) {
      raw = result[k];
    } else {
      continue;
    }
    var n;
    if (typeof raw === "boolean") n = raw ? 1 : 0;
    else if (typeof raw === "number" && isFinite(raw)) n = raw;
    else continue;
    score += weights[k] * n;
  }
  return score;
}

// Rerank an in-memory result roster. `weights` is the active weight set's flat
// signal -> multiplier map (or null / empty for "no weights"); `pins` is the
// array of `{ product_id, position }` for the query (or empty); `results` is
// the matched rows, each carrying a `product_id` (the edge projects `id` ->
// `product_id` before the call, mirroring the container). Returns a NEW array;
// the input is not mutated. Rows missing a `product_id` are dropped from the
// pin lookup but still scored + sorted (the edge guarantees a `product_id` on
// every projected row, so this is defence-in-depth only).
//
// With no weights AND no pins the input order is preserved (the no-op the
// "operator hasn't configured ranking" path takes). With weights but no pins,
// rows reorder by score DESC. With pins, pinned rows lift to the front in pin
// order regardless of score.
export function applyRanking(weights, pins, results) {
  if (!Array.isArray(results) || results.length === 0) return Array.isArray(results) ? results.slice() : [];
  var hasWeights = weights && typeof weights === "object" && Object.keys(weights).length > 0;
  var pinPositionByPid = {};
  if (Array.isArray(pins)) {
    for (var p = 0; p < pins.length; p += 1) {
      var pin = pins[p];
      if (pin && typeof pin.product_id === "string") {
        pinPositionByPid[pin.product_id] = pin.position;
      }
    }
  }

  var pinnedRows = [];
  var unpinnedRows = [];
  for (var i = 0; i < results.length; i += 1) {
    var row = results[i];
    var pid = row && typeof row.product_id === "string" ? row.product_id : null;
    var score = hasWeights ? _scoreResult(row, weights) : 0;
    var pinned = pid != null && Object.prototype.hasOwnProperty.call(pinPositionByPid, pid);
    // Tag the row with the score + pin flag (matches the lib's appended
    // `_score` / `_pinned` keys; inert to the renderer). A shallow copy keeps
    // the caller's input array untouched.
    var tagged = Object.assign({}, row, { _score: score, _pinned: pinned });
    if (pinned) pinnedRows.push(tagged);
    else unpinnedRows.push(tagged);
  }

  pinnedRows.sort(function (a, b) {
    var pa = pinPositionByPid[a.product_id];
    var pb = pinPositionByPid[b.product_id];
    if (pa !== pb) return pa - pb;
    if (a.product_id < b.product_id) return -1;
    if (a.product_id > b.product_id) return 1;
    return 0;
  });
  unpinnedRows.sort(function (a, b) {
    if (b._score !== a._score) return b._score - a._score;
    if (a.product_id < b.product_id) return -1;
    if (a.product_id > b.product_id) return 1;
    return 0;
  });
  return pinnedRows.concat(unpinnedRows);
}

// Hydrate `weights_json` into the flat signal -> number map the scorer reads.
// A malformed / non-object JSON degrades to an empty map (no weights) rather
// than throwing — mirrors the lib's `_hydrateWeightSet` JSON.parse guard.
function _parseWeights(weightsJson) {
  if (weightsJson == null) return {};
  var parsed;
  try { parsed = JSON.parse(weightsJson); }
  catch (_e) { return {}; }                                          // allow:empty-catch-swallow — malformed weights JSON degrades to no weights so a hand-edited row can't 500 the search page
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  var out = {};
  var keys = Object.keys(parsed);
  for (var i = 0; i < keys.length; i += 1) {
    var v = parsed[keys[i]];
    if (typeof v === "number" && isFinite(v)) out[keys[i]] = v;
  }
  return out;
}

// Read the operator's active ranking config for a query off D1: the single
// active (non-archived) weight set's weights, plus the manual pins for the
// normalised query. Returns `{ weights, pins }` — `weights` is the flat map
// (empty when no active set), `pins` is the `{ product_id, position }` list
// (empty when none / when the query can't be normalised). Missing-table-
// resilient on BOTH tables independently so a partially-migrated deploy reads
// the config it has. `normalizedQuery` is the output of `normalizeRankingQuery`
// (or null — null skips the pin read).
export async function loadSearchRanking(DB, normalizedQuery) {
  if (!DB) return { weights: {}, pins: [] };
  var weights = {};
  var pins = [];

  // Active weight set — the storefront ranker reads exactly one active,
  // non-archived set on every query (idx_search_weight_sets_active covers it).
  // ORDER + LIMIT mirror the lib's `_readActiveWeightSet` so a transient
  // multi-active window (mid-flip) resolves to the same row on both sides.
  try {
    var wRes = await DB
      .prepare(
        "SELECT weights_json FROM search_weight_sets " +
        "WHERE active = 1 AND archived_at IS NULL " +
        "ORDER BY updated_at DESC, slug ASC LIMIT 1"
      )
      .bind()
      .all();
    var wRows = (wRes && wRes.results) ? wRes.results : [];
    if (wRows.length) weights = _parseWeights(wRows[0].weights_json);
  } catch (e) {
    if (!(e && /no such table/i.test(e.message || ""))) throw e;
  }

  // Manual pins for the query — ordered by position ASC, created_at ASC to
  // match the lib's `_pinsForNormalizedQuery` (and the migration's covering
  // index). Skipped when the query couldn't be normalised (hostile / empty).
  if (normalizedQuery != null) {
    try {
      var pRes = await DB
        .prepare(
          "SELECT product_id, position FROM search_manual_pins " +
          "WHERE query = ?1 ORDER BY position ASC, created_at ASC"
        )
        .bind(normalizedQuery)
        .all();
      var pRows = (pRes && pRes.results) ? pRes.results : [];
      for (var i = 0; i < pRows.length; i += 1) {
        pins.push({ product_id: pRows[i].product_id, position: Number(pRows[i].position) });
      }
    } catch (e2) {
      if (!(e2 && /no such table/i.test(e2.message || ""))) throw e2;
    }
  }

  return { weights: weights, pins: pins };
}

// Project the edge's matched search rows into the shape `applyRanking` scores:
// `product_id` (from the row's `id`) + a `signals` bag carrying the same two
// signals the container projects (`in_stock` bool, `price_minor` int). Byte-
// for-byte the container's `_rerankUniverse` projection so the two rankers see
// identical signal inputs. The projected row keeps every original field, so
// the reranked array IS the result roster the renderer consumes.
export function projectForRanking(rows) {
  if (!Array.isArray(rows)) return [];
  var out = [];
  for (var i = 0; i < rows.length; i += 1) {
    var r = rows[i];
    out.push(Object.assign({}, r, {
      product_id: r.id,
      signals: {
        in_stock: r.in_stock === true,
        // price_minor is a pass-through integer signal (never divided — no
        // money arithmetic); a null / non-finite price contributes nothing.
        price_minor: (typeof r.price_minor === "number" && isFinite(r.price_minor)) ? r.price_minor : 0,
      },
    }));
  }
  return out;
}
