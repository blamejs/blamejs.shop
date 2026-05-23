"use strict";
/**
 * @module shop.recommendations
 * @title  Recommendations — operator-curated overrides + signal-based picks
 *
 * @intro
 *   Storefront product-recommendation engine. Powers "You might also
 *   like" rails on the product page, "Frequently bought together" on
 *   the cart, "Picked for you" on the customer home, and "More in
 *   this collection" on category pages.
 *
 *   Two layers, in order:
 *
 *     1. Operator-curated override layer. Operators pin specific
 *        product → recommendation pairs ("when viewing product A,
 *        always show product B"). Overrides are kind-scoped (the
 *        same A can have different recommendations on the PDP rail
 *        vs. the cart rail) and ordered by weight DESC, position ASC
 *        so a hand-curated rail renders in operator-controlled order.
 *
 *     2. Signal-based fallback layer. When overrides don't fill the
 *        requested count, the picker falls through to an algorithmic
 *        signal selected per `kind`:
 *
 *          - `product`  → co-purchase (other products bought in the
 *                         same orders as the source product), then
 *                         category-popular (popular products in the
 *                         source product's collection), then random
 *                         in-stock as the last-resort filler.
 *          - `cart`     → co-purchase aggregated across every product
 *                         id in the cart, then category-popular by
 *                         the dominant collection, then random in-stock.
 *          - `customer` → recently-viewed `recommend` (co-view signal,
 *                         composed when the operator wires the
 *                         `recentlyViewed` handle), then category-
 *                         popular from the customer's most-viewed
 *                         collection, then random in-stock.
 *          - `category` → category-popular within the slug, then
 *                         random in-stock from the collection.
 *
 *   Every signal-stage candidate is filtered for archived / out-of-
 *   stock products at render time — the override layer is operator-
 *   orphan-tolerant by design (an override pointing at an archived
 *   product is silently dropped from the rail, not hard-failed,
 *   because re-publishing the product re-enables it).
 *
 *   Composes:
 *     - `b.guardUuid` — every product / customer / cart id is UUID-
 *       shape-validated at the entry point.
 *     - `b.crypto.namespaceHash` — `session_id` on ledger writes is
 *       hashed under the `recommendations-session` namespace so the
 *       raw cookie never lands in the events table.
 *     - `b.uuid.v7` — row ids for both overrides and events.
 *     - `opts.catalog` — required, used for product / variant /
 *       stock lookups during signal stages and the random-in-stock
 *       filler.
 *     - `opts.recentlyViewed` — optional, composed by
 *       `recommendForCustomer` when wired so the customer-personalized
 *       rail can lean on the co-view signal.
 *     - `opts.analytics` — accepted for forward symmetry with the
 *       sibling storefront primitives. Not strictly used today — the
 *       co-purchase signal reads `order_lines` directly so the
 *       primitive works on operators that haven't enabled the
 *       analytics event stream — but the option is wired so a
 *       future "boost picks the analytics dashboard already
 *       surfaces" pass has the dependency in place without a
 *       signature change.
 *
 *   Surface:
 *     - `recommendForProduct(product_id, { limit?, kind? = "product",
 *                                          exclude_ids?, fillFromFallback? })`
 *         → `[{ product_id, source: "override" | "co_purchase" |
 *                                  "category_popular" | "in_stock_random",
 *               weight?, position?, score? }]`
 *     - `recommendForCart(input, opts?)` where input is either an
 *       array of product ids or `{ product_ids }` — kind=cart.
 *     - `recommendForCustomer(customer_id, opts?)` — kind=customer.
 *     - `recommendForCategory(slug, opts?)` — kind=category.
 *     - `setOverride({ kind, source_id, recommended_product_id,
 *                      weight?, position? })` — UPSERT the active row
 *       for the (kind, source_id, recommended_product_id) tuple,
 *       reviving an archived row if one exists.
 *     - `removeOverride({ kind, source_id, recommended_product_id })`
 *       — soft-delete via `archived_at = now`. The unique index
 *       filters non-archived only, so the same triple can be re-added
 *       later without dropping the audit row.
 *     - `listOverrides({ kind, source_id?, includeArchived? = false })`
 *       — active overrides for the kind (+ optional source_id),
 *       ordered weight DESC, position ASC.
 *     - `recordImpression({ kind, source_id, recommended_id,
 *                           session_id?, occurred_at? })`
 *     - `recordClick({ kind, source_id, recommended_id, session_id?,
 *                      occurred_at? })`
 *     - `recordConversion({ kind, source_id, recommended_id,
 *                            session_id?, order_id?, occurred_at? })`
 *     - `metricsForKind(kind, { source_id?, since?, until? })`
 *         → `{ kind, source_id?, since, until, impressions, clicks,
 *              conversions, ctr, conversion_rate, revenue_minor_by_currency }`
 *
 *   Storage:
 *     - `recommendation_overrides` + `recommendation_events`
 *       (migration `0105_recommendations.sql`).
 *
 * @primitive recommendations
 * @related   b.guardUuid, b.crypto.namespaceHash, b.uuid,
 *            shop.recentlyViewed, shop.analytics, shop.catalog
 */

var DEFAULT_LIMIT      = 8;
var MAX_LIMIT          = 50;
var MAX_CART_PRODUCTS  = 50;
var DEFAULT_WEIGHT     = 100;
var MAX_WEIGHT         = 1000000;
var ONE_YEAR_MS        = 365 * 24 * 60 * 60 * 1000;
var DEFAULT_WINDOW_MS  = 30 * 24 * 60 * 60 * 1000;
var KINDS              = ["product", "cart", "customer", "category"];
var EVENT_TYPES        = ["impression", "click", "conversion"];
var SESSION_NAMESPACE  = "recommendations-session";
var SESSION_ID_RE      = /^[A-Za-z0-9_-]{16,64}$/;
var SLUG_RE            = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ---------------------------------------------------------

function _kind(k) {
  if (typeof k !== "string" || KINDS.indexOf(k) === -1) {
    throw new TypeError(
      "recommendations: kind must be one of (" + KINDS.join(", ") +
      "), got " + JSON.stringify(k)
    );
  }
  return k;
}

function _eventType(t) {
  if (typeof t !== "string" || EVENT_TYPES.indexOf(t) === -1) {
    throw new TypeError(
      "recommendations: event_type must be one of (" +
      EVENT_TYPES.join(", ") + "), got " + JSON.stringify(t)
    );
  }
  return t;
}

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError(
      "recommendations: " + label + " — " + (e && e.message || "invalid UUID")
    );
  }
}

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError(
      "recommendations: " + label +
      " must be a lowercase alnum + dash slug, 1..200 chars"
    );
  }
  return s;
}

// `product` / `cart` / `customer` kinds anchor source_id on a UUID;
// `category` anchors on a collection slug.
function _sourceId(kind, s, label) {
  if (kind === "category") return _slug(s, label);
  return _uuid(s, label);
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError(
      "recommendations: " + label + " must be an integer 1.." + MAX_LIMIT
    );
  }
  return n;
}

function _weight(n) {
  if (n == null) return DEFAULT_WEIGHT;
  if (!Number.isInteger(n) || n < 0 || n > MAX_WEIGHT) {
    throw new TypeError(
      "recommendations: weight must be a non-negative integer ≤ " + MAX_WEIGHT
    );
  }
  return n;
}

function _position(n) {
  if (n == null) return 0;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "recommendations: position must be a non-negative integer"
    );
  }
  return n;
}

function _occurredAt(v) {
  if (v == null) return Date.now();
  if (!Number.isInteger(v) || v < 0) {
    throw new TypeError(
      "recommendations: occurred_at must be a non-negative integer (epoch ms)"
    );
  }
  return v;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "recommendations: " + label +
      " must be a non-negative integer (epoch ms)"
    );
  }
  return n;
}

function _resolveWindow(opts) {
  opts = opts || {};
  var now = Date.now();
  var since = opts.since == null ? (now - DEFAULT_WINDOW_MS) : opts.since;
  var until = opts.until == null ? now                       : opts.until;
  _epochMs(since, "since");
  _epochMs(until, "until");
  if (since >= until) {
    throw new TypeError(
      "recommendations: since must be strictly less than until"
    );
  }
  if ((until - since) > ONE_YEAR_MS) {
    throw new TypeError(
      "recommendations: window (until - since) must be ≤ 1 year"
    );
  }
  return { since: since, until: until };
}

function _sessionId(s) {
  if (typeof s !== "string" || !SESSION_ID_RE.test(s)) {
    throw new TypeError(
      "recommendations: session_id must be 16-64 chars of [A-Za-z0-9_-]"
    );
  }
  return s;
}

function _hashSession(s) {
  return _b().crypto.namespaceHash(SESSION_NAMESPACE, s);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (typeof opts !== "object") {
    throw new TypeError("recommendations.create: opts must be an object");
  }
  if (!opts.catalog) {
    throw new TypeError(
      "recommendations.create: opts.catalog required (composes catalog " +
      "for product / variant / stock resolution)"
    );
  }
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // The catalog handle is required at create-time (the factory
  // refusal above guards it), but the picker reads `products` /
  // `variants` / `inventory` via raw SQL through the same `query`
  // function — leaning on the catalog handle's higher-level surface
  // would force every operator to wire one for what is fundamentally
  // a join against tables the schema already owns. The handle is
  // kept on the closure so a future pass that needs catalog.products.
  // get(id) for a render-time enrichment doesn't break the factory
  // signature.
  var _catalog       = opts.catalog;
  var recentlyViewed = opts.recentlyViewed || null;
  // The analytics handle is accepted for parity with sibling
  // storefront primitives. The co-purchase signal reads order_lines
  // directly so operators that haven't enabled the analytics event
  // stream still get useful picks; the option is here so a future
  // "boost picks the dashboard surfaces" pass doesn't break the
  // factory signature.
  var _analytics     = opts.analytics || null;

  // Filter a candidate list down to active (non-archived) products
  // that have at least one in-stock variant. The override layer is
  // operator-orphan-tolerant — overrides pointing at archived /
  // out-of-stock products are silently dropped from the rail.
  async function _filterRenderable(productIds, excludeSet) {
    if (!productIds.length) return [];
    excludeSet = excludeSet || {};
    var placeholders = productIds.map(function (_id, i) { return "?" + (i + 1); }).join(", ");
    // Active products only (the `archived` status value is the
    // catalog's soft-delete signal — there's no archived_at column
    // on the products table).
    var prodSql =
      "SELECT id FROM products WHERE id IN (" + placeholders + ") " +
      "AND status = 'active'";
    var prodRows = (await query(prodSql, productIds)).rows;
    var activeIds = {};
    for (var i = 0; i < prodRows.length; i += 1) activeIds[prodRows[i].id] = true;
    // At least one variant with stock_on_hand > 0.
    var stockSql =
      "SELECT DISTINCT v.product_id AS pid FROM variants v " +
      "JOIN inventory i ON i.sku = v.sku " +
      "WHERE v.product_id IN (" + placeholders + ") AND i.stock_on_hand > 0";
    var stockRows = (await query(stockSql, productIds)).rows;
    var inStock = {};
    for (var j = 0; j < stockRows.length; j += 1) inStock[stockRows[j].pid] = true;
    var out = [];
    for (var k = 0; k < productIds.length; k += 1) {
      var pid = productIds[k];
      if (excludeSet[pid]) continue;
      if (!activeIds[pid]) continue;
      if (!inStock[pid]) continue;
      out.push(pid);
    }
    return out;
  }

  // Look up the source product's primary collection (the membership
  // with the lowest position). Used as the category-popular pivot
  // when the override + co-purchase stages haven't filled the rail.
  async function _primaryCollectionFor(productId) {
    var row = (await query(
      "SELECT collection_slug FROM collection_members WHERE product_id = ?1 " +
      "ORDER BY position ASC, id ASC LIMIT 1",
      [productId],
    )).rows[0];
    return row ? row.collection_slug : null;
  }

  // Co-purchase signal: for each source product id, find every other
  // product id that appeared in the same order, count co-occurrences,
  // sort desc. The fan-out is bounded by the per-source LIMIT on the
  // join — operators with extreme order volumes can pass a tighter
  // `limit` to recommendForProduct / recommendForCart.
  async function _coPurchase(sourceProductIds, sliceLimit) {
    if (!sourceProductIds.length) return [];
    // SQLite reuses numbered placeholders — `?1..?N` bind the source
    // ids once and the same numbers reappear in the NOT IN clause to
    // exclude the seeds. The LIMIT binds to `?{N+1}`.
    var placeholders = sourceProductIds.map(function (_id, i) { return "?" + (i + 1); }).join(", ");
    var limitPlaceholder = "?" + (sourceProductIds.length + 1);
    var sql =
      "SELECT v2.product_id AS pid, COUNT(*) AS hits FROM order_lines ol1 " +
      "JOIN variants v1 ON v1.id = ol1.variant_id " +
      "JOIN order_lines ol2 ON ol2.order_id = ol1.order_id AND ol2.variant_id != ol1.variant_id " +
      "JOIN variants v2 ON v2.id = ol2.variant_id " +
      "WHERE v1.product_id IN (" + placeholders + ") " +
      "  AND v2.product_id NOT IN (" + placeholders + ") " +
      "GROUP BY v2.product_id " +
      "ORDER BY hits DESC, v2.product_id ASC " +
      "LIMIT " + limitPlaceholder;
    var params = sourceProductIds.slice();
    params.push(sliceLimit);
    var rows = (await query(sql, params)).rows;
    return rows.map(function (r) {
      return { product_id: r.pid, score: Number(r.hits) };
    });
  }

  // Category-popular signal: most-ordered products within a
  // collection, by sum of order_line qty. Falls back to membership
  // position when the collection has no order history yet so a
  // brand-new category still renders.
  async function _categoryPopular(collectionSlug, sliceLimit) {
    if (!collectionSlug) return [];
    var rows = (await query(
      "SELECT cm.product_id AS pid, COALESCE(SUM(ol.qty), 0) AS sales " +
      "FROM collection_members cm " +
      "LEFT JOIN variants v ON v.product_id = cm.product_id " +
      "LEFT JOIN order_lines ol ON ol.variant_id = v.id " +
      "WHERE cm.collection_slug = ?1 " +
      "GROUP BY cm.product_id " +
      "ORDER BY sales DESC, cm.position ASC, cm.id ASC " +
      "LIMIT ?2",
      [collectionSlug, sliceLimit],
    )).rows;
    return rows.map(function (r) {
      return { product_id: r.pid, score: Number(r.sales) };
    });
  }

  // Random in-stock filler. Last-resort source so the rail always
  // renders SOMETHING even on a fresh storefront with no order
  // history. Uses RANDOM() for the ordering — pure presentation
  // randomness, no security implication.
  async function _randomInStock(sliceLimit) {
    var rows = (await query(
      "SELECT DISTINCT v.product_id AS pid FROM variants v " +
      "JOIN inventory i ON i.sku = v.sku " +
      "JOIN products p ON p.id = v.product_id " +
      "WHERE i.stock_on_hand > 0 AND p.status = 'active' " +
      "ORDER BY RANDOM() " +
      "LIMIT ?1",
      [sliceLimit],
    )).rows;
    return rows.map(function (r) {
      return { product_id: r.pid, score: 0 };
    });
  }

  // Read the active override layer for a (kind, source_id) tuple.
  async function _activeOverrides(kind, sourceId) {
    return (await query(
      "SELECT * FROM recommendation_overrides " +
      "WHERE kind = ?1 AND source_id = ?2 AND archived_at IS NULL " +
      "ORDER BY weight DESC, position ASC, id ASC",
      [kind, sourceId],
    )).rows;
  }

  // Compose the override + signal stages into a single ordered list
  // bounded by `limit`. Each pick carries a `source` tag so the
  // caller can render "operator-picked" vs. "algorithmic" badges.
  async function _composeRail(kind, sourceId, signalStages, listOpts) {
    listOpts = listOpts || {};
    var limit = _limit(listOpts.limit, "limit");
    var excludeIds = Array.isArray(listOpts.exclude_ids) ? listOpts.exclude_ids : [];
    var excludeSet = {};
    for (var e = 0; e < excludeIds.length; e += 1) excludeSet[excludeIds[e]] = true;
    var fill = listOpts.fillFromFallback !== false;

    var seen = {};
    var out  = [];

    // Stage 1: overrides.
    var ov = await _activeOverrides(kind, sourceId);
    var ovIds = ov.map(function (r) { return r.recommended_product_id; });
    var renderableOv = await _filterRenderable(ovIds, excludeSet);
    var renderableOvSet = {};
    for (var i = 0; i < renderableOv.length; i += 1) renderableOvSet[renderableOv[i]] = true;
    for (var j = 0; j < ov.length && out.length < limit; j += 1) {
      var row = ov[j];
      if (!renderableOvSet[row.recommended_product_id]) continue;
      if (seen[row.recommended_product_id]) continue;
      seen[row.recommended_product_id] = true;
      out.push({
        product_id: row.recommended_product_id,
        source:     "override",
        weight:     Number(row.weight),
        position:   Number(row.position),
      });
    }

    if (!fill) return out;

    // Stage 2+: signal stages, in declared order.
    for (var s = 0; s < signalStages.length && out.length < limit; s += 1) {
      var stage = signalStages[s];
      var candidates = await stage.run(limit * 3);
      var candidateIds = candidates.map(function (c) { return c.product_id; });
      var filtered = await _filterRenderable(candidateIds, Object.assign({}, excludeSet, seen));
      var filteredSet = {};
      for (var f = 0; f < filtered.length; f += 1) filteredSet[filtered[f]] = true;
      for (var m = 0; m < candidates.length && out.length < limit; m += 1) {
        var cand = candidates[m];
        if (!filteredSet[cand.product_id]) continue;
        if (seen[cand.product_id]) continue;
        seen[cand.product_id] = true;
        out.push({
          product_id: cand.product_id,
          source:     stage.name,
          score:      cand.score,
        });
      }
    }

    return out;
  }

  // ---- public surface ---------------------------------------------------

  var api = {
    DEFAULT_LIMIT:     DEFAULT_LIMIT,
    MAX_LIMIT:         MAX_LIMIT,
    KINDS:             KINDS.slice(),
    EVENT_TYPES:       EVENT_TYPES.slice(),
    DEFAULT_WEIGHT:    DEFAULT_WEIGHT,
    DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS,

    // "You might also like" rail anchored on a single PDP product.
    recommendForProduct: async function (productId, listOpts) {
      var pid = _uuid(productId, "product_id");
      listOpts = listOpts || {};
      if (typeof listOpts !== "object") {
        throw new TypeError("recommendations.recommendForProduct: opts must be an object");
      }
      var kind = listOpts.kind == null ? "product" : _kind(listOpts.kind);
      // Self-exclusion: never recommend a product to itself.
      var exclude = (Array.isArray(listOpts.exclude_ids) ? listOpts.exclude_ids : []).concat([pid]);
      var primary = await _primaryCollectionFor(pid);
      var stages = [
        { name: "co_purchase",       run: async function (n) { return _coPurchase([pid], n); } },
        { name: "category_popular",  run: async function (n) { return _categoryPopular(primary, n); } },
        { name: "in_stock_random",   run: async function (n) { return _randomInStock(n); } },
      ];
      return _composeRail(kind, pid, stages, Object.assign({}, listOpts, { exclude_ids: exclude }));
    },

    // "Frequently bought together" — cart-rail picker. Input is
    // either an array of product ids or `{ product_ids }`. The
    // primitive aggregates the co-purchase signal across every
    // product in the cart and pivots category-popular off the cart's
    // dominant collection. The cart's anchor source_id for the
    // override layer is the FIRST product id (operators curate cart
    // overrides anchored on the most-likely-to-appear primary item).
    recommendForCart: async function (input, listOpts) {
      var productIds;
      if (Array.isArray(input)) productIds = input;
      else if (input && Array.isArray(input.product_ids)) productIds = input.product_ids;
      else throw new TypeError("recommendations.recommendForCart: input must be product id array or { product_ids }");
      if (productIds.length === 0) {
        throw new TypeError("recommendations.recommendForCart: at least one product_id required");
      }
      if (productIds.length > MAX_CART_PRODUCTS) {
        throw new TypeError(
          "recommendations.recommendForCart: cart product_ids capped at " + MAX_CART_PRODUCTS
        );
      }
      var validated = productIds.map(function (p, i) {
        return _uuid(p, "product_ids[" + i + "]");
      });
      listOpts = listOpts || {};
      if (typeof listOpts !== "object") {
        throw new TypeError("recommendations.recommendForCart: opts must be an object");
      }
      var anchor = validated[0];
      var primary = await _primaryCollectionFor(anchor);
      var exclude = (Array.isArray(listOpts.exclude_ids) ? listOpts.exclude_ids : []).concat(validated);
      var stages = [
        { name: "co_purchase",       run: async function (n) { return _coPurchase(validated, n); } },
        { name: "category_popular",  run: async function (n) { return _categoryPopular(primary, n); } },
        { name: "in_stock_random",   run: async function (n) { return _randomInStock(n); } },
      ];
      return _composeRail("cart", anchor, stages, Object.assign({}, listOpts, { exclude_ids: exclude }));
    },

    // Customer-personalized home rail. When `opts.recentlyViewed` is
    // wired, the customer's co-view signal drives the first
    // algorithmic stage; otherwise the rail falls straight through
    // to category-popular from the customer's most-purchased
    // collection.
    recommendForCustomer: async function (customerId, listOpts) {
      var cid = _uuid(customerId, "customer_id");
      listOpts = listOpts || {};
      if (typeof listOpts !== "object") {
        throw new TypeError("recommendations.recommendForCustomer: opts must be an object");
      }
      // Pivot category for fallback — the collection the customer
      // has bought from most.
      var pivotRow = (await query(
        "SELECT cm.collection_slug AS slug, COUNT(*) AS hits FROM order_lines ol " +
        "JOIN orders o ON o.id = ol.order_id " +
        "JOIN variants v ON v.id = ol.variant_id " +
        "JOIN collection_members cm ON cm.product_id = v.product_id " +
        "WHERE o.customer_id = ?1 " +
        "GROUP BY cm.collection_slug " +
        "ORDER BY hits DESC LIMIT 1",
        [cid],
      )).rows[0];
      var primary = pivotRow ? pivotRow.slug : null;

      var stages = [];
      if (recentlyViewed && typeof recentlyViewed.recommend === "function") {
        stages.push({
          name: "co_view",
          run:  async function (_n) {
            var recs = await recentlyViewed.recommend(cid, { limit: MAX_LIMIT });
            return recs.map(function (r) { return { product_id: r.product_id, score: r.score }; });
          },
        });
      }
      stages.push({ name: "category_popular", run: async function (n) { return _categoryPopular(primary, n); } });
      stages.push({ name: "in_stock_random",  run: async function (n) { return _randomInStock(n); } });

      return _composeRail("customer", cid, stages, listOpts);
    },

    // Category-page picker. Source_id is the collection slug.
    recommendForCategory: async function (slug, listOpts) {
      var s = _slug(slug, "slug");
      listOpts = listOpts || {};
      if (typeof listOpts !== "object") {
        throw new TypeError("recommendations.recommendForCategory: opts must be an object");
      }
      var stages = [
        { name: "category_popular", run: async function (n) { return _categoryPopular(s, n); } },
        { name: "in_stock_random",  run: async function (n) { return _randomInStock(n); } },
      ];
      return _composeRail("category", s, stages, listOpts);
    },

    // Operator override: UPSERT the active row for the (kind,
    // source_id, recommended_product_id) tuple. If an archived row
    // exists for the same triple it's revived (archived_at = NULL,
    // weight + position re-applied); the unique index filters
    // non-archived only so the audit row for a prior add/remove
    // cycle stays in place.
    setOverride: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("recommendations.setOverride: input object required");
      }
      var kind = _kind(input.kind);
      var sourceId = _sourceId(kind, input.source_id, "source_id");
      var recommended = _uuid(input.recommended_product_id, "recommended_product_id");
      var weight = _weight(input.weight);
      var position = _position(input.position);
      var now = _occurredAt(input.occurred_at);

      // Reusing the recommended product as its own source on the
      // `product` / `cart` kinds is a silent no-op trap (operators
      // accidentally pin "show A when viewing A"). Refuse loudly so
      // the curation UI can surface the error.
      if ((kind === "product" || kind === "cart") && sourceId === recommended) {
        throw new TypeError(
          "recommendations.setOverride: source_id and recommended_product_id " +
          "must differ for kind=" + kind
        );
      }

      // Look up the most recent row for the triple — active or
      // archived — and either revive / update it (preserving the id
      // and audit trail) or insert a fresh row.
      var existing = (await query(
        "SELECT * FROM recommendation_overrides " +
        "WHERE kind = ?1 AND source_id = ?2 AND recommended_product_id = ?3 " +
        "ORDER BY archived_at IS NULL DESC, created_at DESC LIMIT 1",
        [kind, sourceId, recommended],
      )).rows[0];

      if (existing) {
        await query(
          "UPDATE recommendation_overrides SET " +
          "weight = ?1, position = ?2, archived_at = NULL, updated_at = ?3 " +
          "WHERE id = ?4",
          [weight, position, now, existing.id],
        );
        return {
          id:                     existing.id,
          kind:                   kind,
          source_id:              sourceId,
          recommended_product_id: recommended,
          weight:                 weight,
          position:               position,
          status:                 "updated",
        };
      }

      var id = _b().uuid.v7();
      await query(
        "INSERT INTO recommendation_overrides " +
        "(id, kind, source_id, recommended_product_id, weight, position, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
        [id, kind, sourceId, recommended, weight, position, now],
      );
      return {
        id:                     id,
        kind:                   kind,
        source_id:              sourceId,
        recommended_product_id: recommended,
        weight:                 weight,
        position:               position,
        status:                 "inserted",
      };
    },

    // Soft-delete an override. Sets archived_at; the unique active-
    // override index filters archived rows so the same triple can be
    // re-added later via setOverride (which revives the same row).
    removeOverride: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("recommendations.removeOverride: input object required");
      }
      var kind = _kind(input.kind);
      var sourceId = _sourceId(kind, input.source_id, "source_id");
      var recommended = _uuid(input.recommended_product_id, "recommended_product_id");
      var now = _occurredAt(input.occurred_at);
      var r = await query(
        "UPDATE recommendation_overrides SET archived_at = ?1, updated_at = ?1 " +
        "WHERE kind = ?2 AND source_id = ?3 AND recommended_product_id = ?4 " +
        "  AND archived_at IS NULL",
        [now, kind, sourceId, recommended],
      );
      return { removed: Number(r.rowCount || 0) };
    },

    // List active overrides for a kind. `source_id` is optional —
    // omit it to enumerate every active row for the kind (operator
    // dashboard view). `includeArchived` flips the filter so an
    // operator can audit removed picks.
    listOverrides: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("recommendations.listOverrides: opts object required");
      }
      var kind = _kind(listOpts.kind);
      var includeArchived = listOpts.includeArchived === true;
      if (listOpts.source_id != null) {
        var sourceId = _sourceId(kind, listOpts.source_id, "source_id");
        var sql =
          "SELECT * FROM recommendation_overrides " +
          "WHERE kind = ?1 AND source_id = ?2 " +
          (includeArchived ? "" : "AND archived_at IS NULL ") +
          "ORDER BY weight DESC, position ASC, id ASC";
        return (await query(sql, [kind, sourceId])).rows;
      }
      var sql2 =
        "SELECT * FROM recommendation_overrides WHERE kind = ?1 " +
        (includeArchived ? "" : "AND archived_at IS NULL ") +
        "ORDER BY source_id ASC, weight DESC, position ASC, id ASC";
      return (await query(sql2, [kind])).rows;
    },

    // ---- ledger writes -------------------------------------------------

    recordImpression: async function (input) {
      return _recordEvent(input, "impression");
    },
    recordClick: async function (input) {
      return _recordEvent(input, "click");
    },
    recordConversion: async function (input) {
      return _recordEvent(input, "conversion");
    },

    // ---- metrics report -----------------------------------------------

    // CTR + conversion-rate aggregate for the operator dashboard.
    // The window defaults to the last 30 days; the same gates as
    // analytics apply (epoch ms integers, since < until, ≤ 1 year).
    // When `source_id` is supplied the report narrows to that
    // surface; omit it for a kind-wide aggregate.
    metricsForKind: async function (kind, metricsOpts) {
      var k = _kind(kind);
      metricsOpts = metricsOpts || {};
      if (typeof metricsOpts !== "object") {
        throw new TypeError("recommendations.metricsForKind: opts must be an object");
      }
      var w = _resolveWindow(metricsOpts);
      var params = [k, w.since, w.until];
      var sourceClause = "";
      if (metricsOpts.source_id != null) {
        var sourceId = _sourceId(k, metricsOpts.source_id, "source_id");
        params.push(sourceId);
        sourceClause = "AND source_id = ?4 ";
      }
      var rows = (await query(
        "SELECT event_type, COUNT(*) AS cnt FROM recommendation_events " +
        "WHERE kind = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3 " +
        sourceClause +
        "GROUP BY event_type",
        params,
      )).rows;
      var counts = { impression: 0, click: 0, conversion: 0 };
      for (var i = 0; i < rows.length; i += 1) {
        counts[rows[i].event_type] = Number(rows[i].cnt);
      }
      // Revenue attribution: SUM grand_total_minor of orders linked
      // by conversion-row order_id, grouped by currency so multi-
      // currency catalogs don't collapse incompatible figures.
      var revenueRows = (await query(
        "SELECT o.currency AS currency, SUM(o.grand_total_minor) AS revenue " +
        "FROM recommendation_events re " +
        "JOIN orders o ON o.id = re.order_id " +
        "WHERE re.kind = ?1 AND re.event_type = 'conversion' " +
        "  AND re.occurred_at >= ?2 AND re.occurred_at <= ?3 " +
        (metricsOpts.source_id != null ? "AND re.source_id = ?4 " : "") +
        "GROUP BY o.currency",
        params,
      )).rows;
      var revenue = {};
      for (var j = 0; j < revenueRows.length; j += 1) {
        revenue[revenueRows[j].currency] = Number(revenueRows[j].revenue || 0);
      }
      var ctr = counts.impression === 0 ? 0 : counts.click / counts.impression;
      var cr  = counts.click === 0      ? 0 : counts.conversion / counts.click;
      var out = {
        kind:                       k,
        since:                      w.since,
        until:                      w.until,
        impressions:                counts.impression,
        clicks:                     counts.click,
        conversions:                counts.conversion,
        ctr:                        ctr,
        conversion_rate:            cr,
        revenue_minor_by_currency:  revenue,
      };
      if (metricsOpts.source_id != null) out.source_id = params[3];
      return out;
    },
  };

  // Shared ledger writer for impression / click / conversion. The
  // session_id is namespace-hashed at the entry point so the raw
  // cookie never reaches the column. `order_id` is silently dropped
  // on impression / click rows — the schema's nullable column
  // already permits absence, and refusing here would force the
  // operator to branch their hook code.
  async function _recordEvent(input, eventType) {
    if (!input || typeof input !== "object") {
      throw new TypeError("recommendations.record" + _capitalize(eventType) + ": input object required");
    }
    var et = _eventType(eventType);
    var kind = _kind(input.kind);
    var sourceId = _sourceId(kind, input.source_id, "source_id");
    var recommended = _uuid(input.recommended_id, "recommended_id");
    var sessionHash = null;
    if (input.session_id != null && input.session_id !== "") {
      sessionHash = _hashSession(_sessionId(input.session_id));
    }
    var orderId = null;
    if (et === "conversion" && input.order_id != null && input.order_id !== "") {
      orderId = _uuid(input.order_id, "order_id");
    }
    var ts = _occurredAt(input.occurred_at);
    var id = _b().uuid.v7();
    await query(
      "INSERT INTO recommendation_events " +
      "(id, kind, source_id, recommended_id, session_id_hash, event_type, order_id, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      [id, kind, sourceId, recommended, sessionHash, et, orderId, ts],
    );
    return { id: id, occurred_at: ts, event_type: et };
  }

  function _capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  return api;
}

module.exports = {
  create:            create,
  DEFAULT_LIMIT:     DEFAULT_LIMIT,
  MAX_LIMIT:         MAX_LIMIT,
  KINDS:             KINDS.slice(),
  EVENT_TYPES:       EVENT_TYPES.slice(),
  DEFAULT_WEIGHT:    DEFAULT_WEIGHT,
  DEFAULT_WINDOW_MS: DEFAULT_WINDOW_MS,
};
