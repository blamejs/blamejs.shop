"use strict";
/**
 * @module shop.searchRanking
 * @title  Search ranking — operator-tunable storefront search reranker
 *
 * @intro
 *   Storefront search returns a list of candidate products from the
 *   underlying catalog/index. Whatever order the index hands back is
 *   rarely the order the operator wants the shopper to see: a
 *   distribution-centre operator wants in-stock items first; a
 *   margin-conscious operator wants high-margin items lifted; a
 *   merchandiser running a campaign wants three SKUs pinned to the
 *   top of "summer dress" for the next two weeks regardless of what
 *   the relevance score says. `searchRanking` is the surface that
 *   owns those three concerns:
 *
 *     1. Named **weight sets** — an operator declares a flat
 *        signal -> multiplier mapping (e.g. `{ relevance: 1.0,
 *        popularity: 0.5, in_stock: 0.3, margin: 0.2 }`) under a stable
 *        slug. The storefront ranker reads the *active* set on every
 *        query and computes a weighted score per candidate result:
 *
 *            score = sum_signal( weight[signal] * result.signals[signal] )
 *
 *        Results without a signal contribute zero for that signal;
 *        signals not in the weight set contribute zero. Operators can
 *        author multiple weight sets and flip the active one
 *        atomically via `setActiveWeights(slug)`.
 *
 *     2. **Manual pins** — `pinProductForQuery({ query, product_id,
 *        position })` records a (query, product_id) -> position
 *        override. `applyToResults` lifts every pinned product to its
 *        configured position BEFORE the weighted score sort runs;
 *        pinned products keep their relative order even if their
 *        signal-derived score would have ranked them differently. The
 *        query is normalised at the entry point (lowercased +
 *        whitespace-collapsed) so "Summer Dress" and "  summer
 *        dress " resolve to the same pin set.
 *
 *     3. **Event recording + metrics** — `recordSearchEvent({
 *        query, product_id?, event_type, weights_slug, position?,
 *        session_id? })` appends a row to the event log. Three event
 *        types: `impression` (the rendered result list — one row per
 *        product), `click` (the shopper clicked through), `purchase`
 *        (the click closed). `metricsForWeights({ weights_slug, from,
 *        to })` aggregates the log inside a closed time window and
 *        returns:
 *
 *            { impressions, clicks, purchases,
 *              ctr:                clicks / impressions,
 *              conversion_rate:    purchases / impressions,
 *              click_to_purchase:  purchases / clicks }
 *
 *        Ratios are `null` when the denominator is zero (no division
 *        by zero, no fake zero). Operators can A/B two weight sets by
 *        flipping the active one mid-window and reading the per-set
 *        numbers afterwards.
 *
 *   PII handling — `session_id` on `recordSearchEvent` is hashed via
 *   `b.crypto.namespaceHash("search-ranking-session", raw)`; the raw
 *   value never reaches the row. `product_id` is operator-side data
 *   (the merchandiser already knows which SKU is which); no hashing.
 *
 *   Storage:
 *     - search_weight_sets   — named weight set, one active at a time
 *     - search_manual_pins   — (query, product_id) -> position
 *     - search_events        — append-only impression/click/purchase log
 *     (migration `0167_search_ranking.sql`)
 *
 *   Composes:
 *     - `b.uuid.v7`            — id on every event row (monotonic
 *                                lexicographic ordering preserves
 *                                insertion order on ties).
 *     - `b.crypto.namespaceHash` — session id hashing at the door.
 *
 *   Monotonic per-process clock: two writes in the same millisecond
 *   on a fast loop would tie on `updated_at` / `occurred_at` and make
 *   a sort-by-timestamp read ambiguous. `_now()` bumps to `prior + 1`
 *   on collision so the timeline is strictly increasing for the life
 *   of the process.
 *
 *   Surface:
 *     - defineWeights({ slug, name, weights })
 *     - applyToResults({ query?, results, weights_slug? })
 *     - setActiveWeights(slug)
 *     - activeWeights()
 *     - pinProductForQuery({ query, product_id, position })
 *     - unpinProduct({ query, product_id })
 *     - pinsForQuery(query)
 *     - recordSearchEvent({ query, product_id?, event_type,
 *                           weights_slug, position?, session_id? })
 *     - metricsForWeights({ weights_slug, from, to })
 *     - listWeights({ include_archived? })
 *     - archiveWeights(slug)
 *
 * @primitive searchRanking
 * @related   b.uuid, b.crypto.namespaceHash, catalog, searchFacets
 */

var SESSION_NAMESPACE     = "search-ranking-session";

var MAX_SLUG_LEN          = 64;
var MAX_NAME_LEN          = 200;
var MAX_QUERY_LEN         = 500;
var MAX_SIGNAL_NAME_LEN   = 64;
var MAX_SIGNALS_PER_SET   = 32;
var MAX_PRODUCT_ID_LEN    = 128;
var MAX_RESULTS_PER_CALL  = 1000;
var MAX_POSITION          = 1000;
var MAX_SESSION_ID_LEN    = 256;
var MAX_LIST_LIMIT        = 500;
var DEFAULT_LIST_LIMIT    = 100;

var ALLOWED_EVENT_TYPES   = ["impression", "click", "purchase"];

var SLUG_RE               = /^[a-z][a-z0-9_-]*$/;
var SIGNAL_RE             = /^[a-z][a-z0-9_-]*$/;
// product_id is intentionally permissive — operators may key on
// upstream-catalog SKU codes (uppercased, dotted, slashed). The shape
// allow-list is alnum + hyphen + underscore + dot + slash + colon,
// which covers SKU notation across every common upstream system
// without opening the door to control bytes or whitespace.
var PRODUCT_ID_RE         = /^[A-Za-z0-9._:/-]+$/;
var CONTROL_BYTE_RE       = /[\x00-\x1f\x7f]/;
var ZERO_WIDTH_RE         = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var b = require("./vendor/blamejs");

// ---- monotonic clock ---------------------------------------------------
//
// Two writes in the same millisecond on a hot loop would tie on the
// (occurred_at) sort key. Bumping by 1ms on a tie keeps the per-
// process timeline strictly increasing so event ordering + the
// updated_at column reflect issue order even under contention.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _requireObject(input, fnLabel) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(fnLabel + ": input object required");
  }
}

function _slug(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": slug must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError(fnLabel + ": slug must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(fnLabel + ": slug must match /^[a-z][a-z0-9_-]*$/");
  }
  return s;
}

function _name(s, fnLabel) {
  if (typeof s !== "string") {
    throw new TypeError(fnLabel + ": name must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError(fnLabel + ": name must be non-empty after trim");
  }
  if (s.length > MAX_NAME_LEN) {
    throw new TypeError(fnLabel + ": name must be <= " + MAX_NAME_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError(fnLabel + ": name contains control / zero-width bytes");
  }
  return s;
}

function _weights(input, fnLabel) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(fnLabel + ": weights must be a flat object of signal -> finite number");
  }
  var keys = Object.keys(input);
  if (!keys.length) {
    throw new TypeError(fnLabel + ": weights must contain at least one signal");
  }
  if (keys.length > MAX_SIGNALS_PER_SET) {
    throw new TypeError(fnLabel + ": weights must contain <= " + MAX_SIGNALS_PER_SET + " signals");
  }
  var out = {};
  for (var i = 0; i < keys.length; i += 1) {
    var k = keys[i];
    if (typeof k !== "string" || !k.length) {
      throw new TypeError(fnLabel + ": signal name must be a non-empty string");
    }
    if (k.length > MAX_SIGNAL_NAME_LEN) {
      throw new TypeError(fnLabel + ": signal name must be <= " + MAX_SIGNAL_NAME_LEN + " characters");
    }
    if (!SIGNAL_RE.test(k)) {
      throw new TypeError(fnLabel + ": signal name '" + k + "' must match /^[a-z][a-z0-9_-]*$/");
    }
    var v = input[k];
    if (typeof v !== "number" || !isFinite(v)) {
      throw new TypeError(fnLabel + ": weights['" + k + "'] must be a finite number");
    }
    out[k] = v;
  }
  return out;
}

// Operator-supplied search query is normalised before it touches
// storage so "Summer Dress", "summer  dress", and "summer dress\n"
// collapse to a single pin / metrics key. Lowercase + whitespace-
// collapse + trim; reject control + zero-width before normalising so
// a hostile query can't smuggle separator-confusion past the
// normaliser.
function _normalizeQuery(s, fnLabel) {
  if (typeof s !== "string") {
    throw new TypeError(fnLabel + ": query must be a string");
  }
  if (s.length > MAX_QUERY_LEN) {
    throw new TypeError(fnLabel + ": query must be <= " + MAX_QUERY_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError(fnLabel + ": query contains control / zero-width bytes");
  }
  var normalized = s.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized.length) {
    throw new TypeError(fnLabel + ": query must be non-empty after normalisation");
  }
  return normalized;
}

function _productId(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": product_id must be a non-empty string");
  }
  if (s.length > MAX_PRODUCT_ID_LEN) {
    throw new TypeError(fnLabel + ": product_id must be <= " + MAX_PRODUCT_ID_LEN + " characters");
  }
  if (!PRODUCT_ID_RE.test(s)) {
    throw new TypeError(fnLabel + ": product_id must match /^[A-Za-z0-9._:/-]+$/");
  }
  return s;
}

function _position(n, fnLabel) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_POSITION) {
    throw new TypeError(fnLabel + ": position must be an integer 1..." + MAX_POSITION);
  }
  return n;
}

function _eventType(s, fnLabel) {
  if (typeof s !== "string" || ALLOWED_EVENT_TYPES.indexOf(s) === -1) {
    throw new TypeError(fnLabel + ": event_type must be one of " + ALLOWED_EVENT_TYPES.join(", "));
  }
  return s;
}

function _sessionIdRaw(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": session_id must be a non-empty string");
  }
  if (s.length > MAX_SESSION_ID_LEN) {
    throw new TypeError(fnLabel + ": session_id must be <= " + MAX_SESSION_ID_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError(fnLabel + ": session_id contains control / zero-width bytes");
  }
  return s;
}

function _timestampRange(from, to, fnLabel) {
  if (!Number.isInteger(from) || from < 0) {
    throw new TypeError(fnLabel + ": from must be a non-negative integer (ms epoch)");
  }
  if (!Number.isInteger(to) || to < 0) {
    throw new TypeError(fnLabel + ": to must be a non-negative integer (ms epoch)");
  }
  if (from > to) {
    throw new TypeError(fnLabel + ": from must be <= to");
  }
}

function _limit(n, max, def, fnLabel) {
  if (n == null) return def;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TypeError(fnLabel + ": limit must be an integer 1..." + max);
  }
  return n;
}

// ---- hydration ---------------------------------------------------------

function _hydrateWeightSet(row) {
  if (!row) return null;
  var weights;
  try { weights = JSON.parse(row.weights_json || "{}"); }
  catch (_e) { weights = {}; }
  return {
    slug:        row.slug,
    name:        row.name,
    weights:     weights,
    active:      Number(row.active) === 1,
    archived_at: row.archived_at == null ? null : Number(row.archived_at),
    created_at:  Number(row.created_at),
    updated_at:  Number(row.updated_at),
  };
}

function _hydratePin(row) {
  if (!row) return null;
  return {
    query:      row.query,
    product_id: row.product_id,
    position:   Number(row.position),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Catalog binding is optional — `applyToResults` ranks an in-memory
  // result roster the caller already has. Operators that want the
  // primitive to fetch candidates themselves can pass a catalog with
  // `.list({ query })`; absent, every call must supply `results`.
  var catalog = opts.catalog || null;
  if (catalog && typeof catalog.list !== "function") {
    throw new TypeError("searchRanking.create: catalog must expose a .list({ query }) function when provided");
  }

  function _hashSession(raw) {
    return b.crypto.namespaceHash(SESSION_NAMESPACE, raw);
  }

  async function _readWeightSet(slug) {
    var r = await query(
      "SELECT slug, name, weights_json, active, archived_at, created_at, updated_at " +
      "FROM search_weight_sets WHERE slug = ?1",
      [slug]
    );
    return r.rows[0] || null;
  }

  async function _readActiveWeightSet() {
    var r = await query(
      "SELECT slug, name, weights_json, active, archived_at, created_at, updated_at " +
      "FROM search_weight_sets WHERE active = 1 AND archived_at IS NULL " +
      "ORDER BY updated_at DESC, slug ASC LIMIT 1",
      []
    );
    return r.rows[0] || null;
  }

  async function _pinsForNormalizedQuery(normalizedQuery) {
    var r = await query(
      "SELECT query, product_id, position, created_at, updated_at " +
      "FROM search_manual_pins WHERE query = ?1 " +
      "ORDER BY position ASC, created_at ASC",
      [normalizedQuery]
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydratePin(r.rows[i]));
    return out;
  }

  // Compute the weighted score for a single result row against a
  // weight set. Signals are looked up on `result.signals` first
  // (the dedicated bucket) and fall back to top-level keys on the
  // result itself for convenience. Missing signals contribute zero.
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

  return {
    SESSION_NAMESPACE:       SESSION_NAMESPACE,
    MAX_SLUG_LEN:            MAX_SLUG_LEN,
    MAX_NAME_LEN:            MAX_NAME_LEN,
    MAX_QUERY_LEN:           MAX_QUERY_LEN,
    MAX_SIGNAL_NAME_LEN:     MAX_SIGNAL_NAME_LEN,
    MAX_SIGNALS_PER_SET:     MAX_SIGNALS_PER_SET,
    MAX_PRODUCT_ID_LEN:      MAX_PRODUCT_ID_LEN,
    MAX_RESULTS_PER_CALL:    MAX_RESULTS_PER_CALL,
    MAX_POSITION:            MAX_POSITION,
    MAX_LIST_LIMIT:          MAX_LIST_LIMIT,
    ALLOWED_EVENT_TYPES:     ALLOWED_EVENT_TYPES.slice(),

    // Define / re-define a named weight set. Idempotent on slug —
    // re-defining replaces `name` + `weights` in place and bumps
    // `updated_at`; `created_at` is preserved. The `active` flag
    // is owned by `setActiveWeights` and is NOT touched here; a
    // re-define on the currently-active set keeps it active.
    defineWeights: async function (input) {
      _requireObject(input, "searchRanking.defineWeights");
      var slug    = _slug(input.slug,        "searchRanking.defineWeights");
      var name    = _name(input.name,        "searchRanking.defineWeights");
      var weights = _weights(input.weights,  "searchRanking.defineWeights");
      var ts      = _now();

      var existing = await _readWeightSet(slug);
      if (existing) {
        if (existing.archived_at != null) {
          var aErr = new Error(
            "searchRanking.defineWeights: weight set '" + slug + "' is archived; re-author under a new slug"
          );
          aErr.code = "SEARCH_WEIGHTS_ARCHIVED";
          throw aErr;
        }
        await query(
          "UPDATE search_weight_sets SET name = ?1, weights_json = ?2, updated_at = ?3 " +
          "WHERE slug = ?4",
          [name, JSON.stringify(weights), ts, slug]
        );
      } else {
        await query(
          "INSERT INTO search_weight_sets " +
          "(slug, name, weights_json, active, archived_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, 0, NULL, ?4, ?4)",
          [slug, name, JSON.stringify(weights), ts]
        );
      }
      var fresh = await _readWeightSet(slug);
      return _hydrateWeightSet(fresh);
    },

    // Apply a weight set + manual pins to an in-memory result list.
    // Pins always come first in pin-position order; remaining
    // results sort by weighted score DESC with ties broken by
    // product_id ASC for determinism. When `weights_slug` is
    // omitted the active set is used; when no active set exists +
    // no slug supplied, the original input order is preserved and a
    // synthetic `_score = 0` is attached so the caller can tell the
    // ranker didn't fire.
    //
    // Input shape: results is `[{ product_id, signals?, ... }]`. The
    // returned array is the same shape with `_score` + `_pinned`
    // appended to each row. A missing `product_id` on any row throws
    // — the primitive can't pin / score / event-log a row it can't
    // identify.
    applyToResults: async function (input) {
      _requireObject(input, "searchRanking.applyToResults");
      if (!Array.isArray(input.results)) {
        throw new TypeError("searchRanking.applyToResults: results must be an array");
      }
      if (input.results.length > MAX_RESULTS_PER_CALL) {
        throw new TypeError(
          "searchRanking.applyToResults: results must contain <= " + MAX_RESULTS_PER_CALL + " entries"
        );
      }
      var normalizedQuery = null;
      if (input.query != null) {
        normalizedQuery = _normalizeQuery(input.query, "searchRanking.applyToResults");
      }
      // Validate every row carries a product_id BEFORE doing any
      // work, so partial application can't leak past a rejected
      // call.
      var validated = [];
      for (var i = 0; i < input.results.length; i += 1) {
        var r = input.results[i];
        if (!r || typeof r !== "object") {
          throw new TypeError("searchRanking.applyToResults: results[" + i + "] must be an object");
        }
        var pid = _productId(r.product_id, "searchRanking.applyToResults: results[" + i + "]");
        validated.push({ row: r, product_id: pid });
      }

      // Load weight set: explicit slug wins, otherwise active set,
      // otherwise no-op.
      var weightSet = null;
      if (input.weights_slug != null) {
        var slug = _slug(input.weights_slug, "searchRanking.applyToResults");
        var row = await _readWeightSet(slug);
        if (!row || row.archived_at != null) {
          var nfErr = new Error(
            "searchRanking.applyToResults: weight set '" + slug + "' not found"
          );
          nfErr.code = "SEARCH_WEIGHTS_NOT_FOUND";
          throw nfErr;
        }
        weightSet = _hydrateWeightSet(row);
      } else {
        var activeRow = await _readActiveWeightSet();
        if (activeRow) weightSet = _hydrateWeightSet(activeRow);
      }
      var weights = weightSet ? weightSet.weights : null;

      var pins = [];
      if (normalizedQuery) {
        pins = await _pinsForNormalizedQuery(normalizedQuery);
      }
      var pinPositionByPid = {};
      for (var p = 0; p < pins.length; p += 1) {
        pinPositionByPid[pins[p].product_id] = pins[p].position;
      }

      // Score + tag every result row.
      var scored = [];
      for (var s = 0; s < validated.length; s += 1) {
        var entry = validated[s];
        var score = weights ? _scoreResult(entry.row, weights) : 0;
        var pinned = Object.prototype.hasOwnProperty.call(pinPositionByPid, entry.product_id);
        var out = Object.assign({}, entry.row, {
          product_id: entry.product_id,
          _score:     score,
          _pinned:    pinned,
        });
        scored.push(out);
      }

      // Split into pinned + unpinned. Pinned rows sort by pin
      // position ASC (ties by product_id ASC). Unpinned rows sort by
      // weighted score DESC (ties by product_id ASC). Concatenate
      // pinned-first so the merchandiser override always wins.
      var pinnedRows   = [];
      var unpinnedRows = [];
      for (var sr = 0; sr < scored.length; sr += 1) {
        if (scored[sr]._pinned) pinnedRows.push(scored[sr]);
        else                    unpinnedRows.push(scored[sr]);
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
    },

    // Flip one weight set into the live ranker. Clears the prior
    // `active = 1` flag in the same call so the invariant "exactly
    // one active set" holds. A no-op when the slug is already
    // active.
    setActiveWeights: async function (slug) {
      slug = _slug(slug, "searchRanking.setActiveWeights");
      var existing = await _readWeightSet(slug);
      if (!existing) {
        var nfErr = new Error("searchRanking.setActiveWeights: weight set '" + slug + "' not found");
        nfErr.code = "SEARCH_WEIGHTS_NOT_FOUND";
        throw nfErr;
      }
      if (existing.archived_at != null) {
        var aErr = new Error("searchRanking.setActiveWeights: weight set '" + slug + "' is archived");
        aErr.code = "SEARCH_WEIGHTS_ARCHIVED";
        throw aErr;
      }
      var ts = _now();
      // Two writes — clear-then-set. The unique-active invariant
      // holds across both rows because no other surface flips
      // `active` and the clear runs before the set.
      await query(
        "UPDATE search_weight_sets SET active = 0, updated_at = ?1 WHERE active = 1 AND slug <> ?2",
        [ts, slug]
      );
      await query(
        "UPDATE search_weight_sets SET active = 1, updated_at = ?1 WHERE slug = ?2",
        [ts, slug]
      );
      var fresh = await _readWeightSet(slug);
      return _hydrateWeightSet(fresh);
    },

    activeWeights: async function () {
      var row = await _readActiveWeightSet();
      return _hydrateWeightSet(row);
    },

    // Pin a product to a fixed position for a query. Re-pinning
    // (query, product_id) replaces the position in place; the
    // (query, product_id) PK collapses repeat pins into one row.
    // Two products can share a pin position; the deterministic
    // tiebreak is created_at ASC (older pin wins the higher slot).
    pinProductForQuery: async function (input) {
      _requireObject(input, "searchRanking.pinProductForQuery");
      var normalizedQuery = _normalizeQuery(input.query, "searchRanking.pinProductForQuery");
      var productId = _productId(input.product_id, "searchRanking.pinProductForQuery");
      var position  = _position(input.position, "searchRanking.pinProductForQuery");
      var ts = _now();

      var r = await query(
        "SELECT created_at FROM search_manual_pins WHERE query = ?1 AND product_id = ?2",
        [normalizedQuery, productId]
      );
      if (r.rows.length) {
        await query(
          "UPDATE search_manual_pins SET position = ?1, updated_at = ?2 " +
          "WHERE query = ?3 AND product_id = ?4",
          [position, ts, normalizedQuery, productId]
        );
      } else {
        await query(
          "INSERT INTO search_manual_pins (query, product_id, position, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?4)",
          [normalizedQuery, productId, position, ts]
        );
      }
      var fresh = await query(
        "SELECT query, product_id, position, created_at, updated_at " +
        "FROM search_manual_pins WHERE query = ?1 AND product_id = ?2",
        [normalizedQuery, productId]
      );
      return _hydratePin(fresh.rows[0]);
    },

    // Remove a pin. Returns `{ removed: true }` on hit, `{ removed:
    // false }` when the (query, product_id) wasn't pinned (an
    // operator clicking "unpin" twice shouldn't see an error).
    unpinProduct: async function (input) {
      _requireObject(input, "searchRanking.unpinProduct");
      var normalizedQuery = _normalizeQuery(input.query, "searchRanking.unpinProduct");
      var productId = _productId(input.product_id, "searchRanking.unpinProduct");
      var r = await query(
        "DELETE FROM search_manual_pins WHERE query = ?1 AND product_id = ?2",
        [normalizedQuery, productId]
      );
      var changes = r && (r.rowCount != null ? r.rowCount : (r.changes != null ? r.changes : 0));
      return { removed: Number(changes) > 0 };
    },

    pinsForQuery: async function (queryInput) {
      var normalizedQuery = _normalizeQuery(queryInput, "searchRanking.pinsForQuery");
      return await _pinsForNormalizedQuery(normalizedQuery);
    },

    // Append-only impression / click / purchase event. The
    // weights_slug must reference a known weight set so the rollup
    // math has something to aggregate against — archived sets are
    // still accepted so historical metrics for a deprecated set
    // remain queryable.
    recordSearchEvent: async function (input) {
      _requireObject(input, "searchRanking.recordSearchEvent");
      var normalizedQuery = _normalizeQuery(input.query, "searchRanking.recordSearchEvent");
      var eventType  = _eventType(input.event_type, "searchRanking.recordSearchEvent");
      var weightsSlug = _slug(input.weights_slug, "searchRanking.recordSearchEvent");
      var existing = await _readWeightSet(weightsSlug);
      if (!existing) {
        var nfErr = new Error(
          "searchRanking.recordSearchEvent: weight set '" + weightsSlug + "' not found"
        );
        nfErr.code = "SEARCH_WEIGHTS_NOT_FOUND";
        throw nfErr;
      }
      var productId = null;
      if (input.product_id != null) {
        productId = _productId(input.product_id, "searchRanking.recordSearchEvent");
      }
      var position = null;
      if (input.position != null) {
        position = _position(input.position, "searchRanking.recordSearchEvent");
      }
      var sessionHash = null;
      if (input.session_id != null) {
        sessionHash = _hashSession(_sessionIdRaw(input.session_id, "searchRanking.recordSearchEvent"));
      }
      var ts = _now();
      await query(
        "INSERT INTO search_events " +
        "(id, query, product_id, weights_slug, event_type, position, session_id_hash, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        [b.uuid.v7(), normalizedQuery, productId, weightsSlug, eventType, position, sessionHash, ts]
      );
      return {
        query:        normalizedQuery,
        product_id:   productId,
        weights_slug: weightsSlug,
        event_type:   eventType,
        position:     position,
        occurred_at:  ts,
      };
    },

    // Aggregate the event log for a weight set inside a closed time
    // window. Returns counts per event type plus the three ratios
    // operators read: CTR (clicks / impressions), conversion_rate
    // (purchases / impressions), click_to_purchase (purchases /
    // clicks). Ratios are `null` when the denominator is zero — no
    // division-by-zero, no fake zero ratio that would lie to the
    // operator about "0% CTR" on a window where the result list
    // never rendered.
    metricsForWeights: async function (input) {
      _requireObject(input, "searchRanking.metricsForWeights");
      var weightsSlug = _slug(input.weights_slug, "searchRanking.metricsForWeights");
      var from = input.from;
      var to   = input.to;
      _timestampRange(from, to, "searchRanking.metricsForWeights");

      var existing = await _readWeightSet(weightsSlug);
      if (!existing) {
        var nfErr = new Error(
          "searchRanking.metricsForWeights: weight set '" + weightsSlug + "' not found"
        );
        nfErr.code = "SEARCH_WEIGHTS_NOT_FOUND";
        throw nfErr;
      }

      var r = await query(
        "SELECT event_type, COUNT(*) AS c FROM search_events " +
        "WHERE weights_slug = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3 " +
        "GROUP BY event_type",
        [weightsSlug, from, to]
      );
      var impressions = 0;
      var clicks      = 0;
      var purchases   = 0;
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var c = Number(row.c) || 0;
        if      (row.event_type === "impression") impressions = c;
        else if (row.event_type === "click")      clicks      = c;
        else if (row.event_type === "purchase")   purchases   = c;
      }
      return {
        weights_slug:      weightsSlug,
        from:              from,
        to:                to,
        impressions:       impressions,
        clicks:            clicks,
        purchases:         purchases,
        ctr:               impressions > 0 ? clicks    / impressions : null,
        conversion_rate:   impressions > 0 ? purchases / impressions : null,
        click_to_purchase: clicks > 0      ? purchases / clicks      : null,
      };
    },

    listWeights: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = _limit(listOpts.limit, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT, "searchRanking.listWeights");
      var includeArchived = listOpts.include_archived === true;
      var sql;
      var params = [];
      if (includeArchived) {
        sql = "SELECT slug, name, weights_json, active, archived_at, created_at, updated_at " +
              "FROM search_weight_sets ORDER BY active DESC, updated_at DESC, slug ASC LIMIT ?1";
        params.push(limit);
      } else {
        sql = "SELECT slug, name, weights_json, active, archived_at, created_at, updated_at " +
              "FROM search_weight_sets WHERE archived_at IS NULL " +
              "ORDER BY active DESC, updated_at DESC, slug ASC LIMIT ?1";
        params.push(limit);
      }
      var r = await query(sql, params);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateWeightSet(r.rows[i]));
      return out;
    },

    // Soft-delete a weight set. Sets `archived_at` + clears
    // `active`; historical event rows referencing this slug remain
    // intact so `metricsForWeights` keeps reporting on the
    // deprecated set. Archived sets are excluded from
    // `applyToResults`, `setActiveWeights`, and the default
    // `listWeights` view. Operators wanting to re-author under the
    // same slug pick a new one — archived sets are permanent
    // tombstones to keep the historical event log unambiguous.
    archiveWeights: async function (slug) {
      slug = _slug(slug, "searchRanking.archiveWeights");
      var existing = await _readWeightSet(slug);
      if (!existing) {
        var nfErr = new Error("searchRanking.archiveWeights: weight set '" + slug + "' not found");
        nfErr.code = "SEARCH_WEIGHTS_NOT_FOUND";
        throw nfErr;
      }
      if (existing.archived_at != null) {
        // Idempotent — re-archiving an already-archived set is a
        // no-op, returns the existing tombstone.
        return _hydrateWeightSet(existing);
      }
      var ts = _now();
      await query(
        "UPDATE search_weight_sets SET archived_at = ?1, active = 0, updated_at = ?1 WHERE slug = ?2",
        [ts, slug]
      );
      var fresh = await _readWeightSet(slug);
      return _hydrateWeightSet(fresh);
    },

    // Catalog passthrough — when a catalog binding was provided to
    // the factory, this is the convenience wrapper for "fetch
    // candidates, rank them, return the ranked list" in a single
    // call. When no catalog was provided the caller must use
    // `applyToResults` directly with its own roster.
    rankQuery: async function (input) {
      _requireObject(input, "searchRanking.rankQuery");
      if (!catalog) {
        throw new TypeError(
          "searchRanking.rankQuery: no catalog binding configured on this instance"
        );
      }
      var normalizedQuery = _normalizeQuery(input.query, "searchRanking.rankQuery");
      var listResult = await catalog.list({ query: normalizedQuery });
      var rows = (listResult && listResult.rows) || [];
      return await this.applyToResults({
        query:         normalizedQuery,
        results:       rows,
        weights_slug:  input.weights_slug,
      });
    },
  };
}

module.exports = {
  create:              create,
  SESSION_NAMESPACE:   SESSION_NAMESPACE,
  MAX_SLUG_LEN:        MAX_SLUG_LEN,
  MAX_NAME_LEN:        MAX_NAME_LEN,
  MAX_QUERY_LEN:       MAX_QUERY_LEN,
  MAX_SIGNAL_NAME_LEN: MAX_SIGNAL_NAME_LEN,
  MAX_SIGNALS_PER_SET: MAX_SIGNALS_PER_SET,
  MAX_PRODUCT_ID_LEN:  MAX_PRODUCT_ID_LEN,
  MAX_RESULTS_PER_CALL: MAX_RESULTS_PER_CALL,
  MAX_POSITION:        MAX_POSITION,
  MAX_LIST_LIMIT:      MAX_LIST_LIMIT,
  ALLOWED_EVENT_TYPES: ALLOWED_EVENT_TYPES.slice(),
};
