"use strict";
/**
 * @module shop.collections
 * @title  Collections primitive — operator-curated and smart product lists
 *
 * @intro
 *   A collection groups products under a slug for category pages,
 *   homepage callouts, and navigation menus. Two flavours, one
 *   surface:
 *
 *     manual — operator handpicks members. The primitive owns an
 *              ordered join table (collection_members) and exposes
 *              addProduct / removeProduct / reorderProducts.
 *
 *     smart  — operator authors a rule set against catalog product
 *              fields. Membership is computed at read time by
 *              evaluating the rules against the catalog's products;
 *              no materialised join. Useful for "every sale-tagged
 *              product under $50" without operator bookkeeping.
 *
 *   Rule shape:
 *
 *     { all: [<rule>, ...]?, any: [<rule>, ...]? }
 *
 *   A rule is `{ field, op, value }`. Field is one of
 *   `tags / price_minor / inventory_count / created_at / category /
 *   vendor`. Op is one of `eq / neq / contains / gt / gte / lt / lte
 *   / in / not_in / between`. The semantics:
 *
 *     - `eq` / `neq`         — strict equality / inequality.
 *     - `contains`           — array-field membership (e.g. `tags`
 *       contains "sale"). Refuses on scalar fields.
 *     - `gt / gte / lt / lte` — numeric comparison.
 *     - `in / not_in`        — value within / outside an array.
 *     - `between`            — `value` is `[lo, hi]` inclusive,
 *       numeric only.
 *
 *   A product matches the rule set when ALL rules in `all` are true
 *   AND ANY rule in `any` is true. Either group may be omitted (an
 *   empty group is treated as vacuously true), but at least one
 *   group must be non-empty so a smart collection never matches the
 *   entire catalog by accident.
 *
 *   Composes:
 *     - `b.guardUuid`   — every product_id is UUID-shape-validated.
 *     - `b.uuid.v7`     — collection_members.id (lexicographic +
 *       monotonic so a pagination tiebreak is stable).
 *     - `b.pagination`  — HMAC-tagged cursors on (position, id) for
 *       manual; on (id) for smart (smart sort strategies dictate the
 *       order key).
 *     - `b.safeSql`     — column allow-list on `update(slug, patch)`.
 *
 *   Surface:
 *     - `defineManual({ slug, title, description?, hero_image_url?,
 *                       sort_order? })`
 *     - `defineSmart({ slug, title, description?, rules,
 *                      sort_strategy })`
 *     - `get(slug)`
 *     - `list({ active_only? | archived_only? })`
 *     - `update(slug, patch)` — title / description / hero_image_url
 *       / sort_strategy / rules (smart only).
 *     - `archive(slug)` — soft delete via archived_at column.
 *     - `addProduct({ collection_slug, product_id, position? })`
 *     - `removeProduct({ collection_slug, product_id })`
 *     - `reorderProducts({ collection_slug, ordered_product_ids })`
 *     - `productsIn({ slug, limit?, cursor? })` — manual returns the
 *       curated rows; smart iterates the catalog and applies the
 *       rules.
 *     - `collectionsForProduct(product_id)` — reverse lookup,
 *       combines manual membership + smart rule evaluation.
 *     - `evaluateRules({ rules, product })` — pure helper, exported
 *       for tests.
 *
 *   Storage: `migrations-d1/0043_collections.sql` — two tables,
 *   `collections` + `collection_members`. ON DELETE CASCADE drops
 *   member rows when a collection is hard-deleted (the primitive
 *   only soft-deletes via `archive`; hard delete is an operator-side
 *   migration concern).
 *
 * @primitive collections
 * @related   b.guardUuid, b.pagination, b.uuid, b.safeSql
 */

var b = require("./vendor/blamejs");

var SLUG_RE          = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;
var MAX_TITLE_LEN    = 500;
var MAX_DESC_LEN     = 100000;
var MAX_HERO_URL_LEN = 2048;
var MAX_LIMIT        = 200;
var DEFAULT_LIMIT    = 50;

var COLLECTION_TYPES = Object.freeze(["manual", "smart"]);
var SORT_STRATEGIES  = Object.freeze([
  "manual", "best_selling", "newest", "price_asc", "price_desc", "alphabetical",
]);
var RULE_FIELDS      = Object.freeze([
  "tags", "price_minor", "inventory_count", "created_at", "category", "vendor",
]);
var RULE_OPS         = Object.freeze([
  "eq", "neq", "contains", "gt", "gte", "lt", "lte", "in", "not_in", "between",
]);

// Fields with array semantics — only these accept `contains`. The
// other fields are scalars and `contains` against them throws.
var ARRAY_FIELDS = Object.freeze(["tags"]);

// Fields with numeric semantics — only these accept gt/gte/lt/lte
// and `between`. `eq / neq / in / not_in` still work on numerics too.
var NUMERIC_FIELDS = Object.freeze(["price_minor", "inventory_count", "created_at"]);

// Mutable columns for `update(slug, patch)`. Slug + type +
// created_at are immutable — operators archive + redefine to
// re-key. `rules_json` is patched via a dedicated path so the
// type=smart guard runs before the SQL hits.
var ALLOWED_COLUMNS = Object.freeze([
  "title", "description", "hero_image_url", "sort_strategy",
]);

var MEMBER_ORDER_KEY      = ["position:asc", "id:asc"];
var SMART_ORDER_KEY       = ["offset:asc"];

// ---- validators ----------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("collections: slug must be lowercase alnum + dash, no leading/trailing dash, 1..200 chars");
  }
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("collections: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
}

function _description(s) {
  if (s == null) return "";
  if (typeof s !== "string") {
    throw new TypeError("collections: description must be a string or null");
  }
  if (s.length > MAX_DESC_LEN) {
    throw new TypeError("collections: description must be <= " + MAX_DESC_LEN + " chars");
  }
  return s;
}

function _heroUrl(s) {
  if (s == null || s === "") return null;
  if (typeof s !== "string") {
    throw new TypeError("collections: hero_image_url must be a string or null");
  }
  if (s.length > MAX_HERO_URL_LEN) {
    throw new TypeError("collections: hero_image_url must be <= " + MAX_HERO_URL_LEN + " chars");
  }
  // Defense in depth: control bytes (CR/LF/NUL) refused so a
  // malicious url can't smuggle header-injection content into a
  // storefront <meta> tag that's rendered from this column.
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("collections: hero_image_url must not contain control bytes");
  }
  return s;
}

function _sortStrategy(s, type) {
  if (typeof s !== "string" || SORT_STRATEGIES.indexOf(s) < 0) {
    throw new TypeError("collections: sort_strategy must be one of " + SORT_STRATEGIES.join(", "));
  }
  // `manual` only makes sense for a manual collection (the operator
  // controls the order via reorderProducts). Refuse on smart — a
  // smart collection has no stable member order to manualise.
  if (s === "manual" && type === "smart") {
    throw new TypeError("collections: sort_strategy 'manual' is only valid for manual collections");
  }
  return s;
}

function _productId(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("collections: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _validateRule(rule, idx, group) {
  if (!rule || typeof rule !== "object") {
    throw new TypeError("collections: rules." + group + "[" + idx + "] must be an object");
  }
  if (typeof rule.field !== "string" || RULE_FIELDS.indexOf(rule.field) < 0) {
    throw new TypeError("collections: rules." + group + "[" + idx + "].field must be one of " + RULE_FIELDS.join(", "));
  }
  if (typeof rule.op !== "string" || RULE_OPS.indexOf(rule.op) < 0) {
    throw new TypeError("collections: rules." + group + "[" + idx + "].op must be one of " + RULE_OPS.join(", "));
  }
  // contains -> array field only.
  if (rule.op === "contains" && ARRAY_FIELDS.indexOf(rule.field) < 0) {
    throw new TypeError("collections: rules." + group + "[" + idx + "].op 'contains' requires an array field (" +
                        ARRAY_FIELDS.join(", ") + ")");
  }
  // gt/gte/lt/lte/between -> numeric field only.
  var numericOp = rule.op === "gt" || rule.op === "gte" || rule.op === "lt" || rule.op === "lte" || rule.op === "between";
  if (numericOp && NUMERIC_FIELDS.indexOf(rule.field) < 0) {
    throw new TypeError("collections: rules." + group + "[" + idx + "].op '" + rule.op +
                        "' requires a numeric field (" + NUMERIC_FIELDS.join(", ") + ")");
  }
  if (rule.op === "between") {
    if (!Array.isArray(rule.value) || rule.value.length !== 2 ||
        typeof rule.value[0] !== "number" || typeof rule.value[1] !== "number") {
      throw new TypeError("collections: rules." + group + "[" + idx + "].value for 'between' must be [lo, hi] numbers");
    }
  } else if (rule.op === "in" || rule.op === "not_in") {
    if (!Array.isArray(rule.value)) {
      throw new TypeError("collections: rules." + group + "[" + idx + "].value for '" + rule.op + "' must be an array");
    }
  } else if (rule.value === undefined) {
    throw new TypeError("collections: rules." + group + "[" + idx + "].value is required");
  }
}

function _validateRules(rules) {
  if (!rules || typeof rules !== "object") {
    throw new TypeError("collections: rules must be an object { all?: [...], any?: [...] }");
  }
  var all = rules.all == null ? [] : rules.all;
  var any = rules.any == null ? [] : rules.any;
  if (!Array.isArray(all)) {
    throw new TypeError("collections: rules.all must be an array");
  }
  if (!Array.isArray(any)) {
    throw new TypeError("collections: rules.any must be an array");
  }
  if (all.length === 0 && any.length === 0) {
    throw new TypeError("collections: rules must specify at least one rule in `all` or `any`");
  }
  for (var i = 0; i < all.length; i += 1) _validateRule(all[i], i, "all");
  for (var j = 0; j < any.length; j += 1) _validateRule(any[j], j, "any");
  return { all: all, any: any };
}

function _now() { return Date.now(); }

// ---- pure rule evaluator -------------------------------------------------

// Returns true if `product` satisfies the rule. Read-only against
// the product object; no I/O. The factory's `evaluateRules` wraps
// this with rule-set validation so tests can exercise every op
// in isolation against a synthetic product.
function _matchRule(rule, product) {
  var fieldVal = product == null ? undefined : product[rule.field];
  // A catalog field can be MULTI-VALUED — a product carries an array
  // of `tags` and an array of `category` memberships. For the scalar
  // ops (`eq` / `neq` / `in` / `not_in`) an array field matches with
  // membership semantics ("any of the product's categories equals X").
  // A scalar field value keeps strict-equality semantics, so the
  // existing single-valued fields (`vendor`, numeric fields) are
  // unaffected. This is what lets a smart rule like
  // `{ field: "category", op: "eq", value: "apparel" }` match a
  // product that lives in apparel + clearance + outdoor.
  var isArrayVal = Array.isArray(fieldVal);
  switch (rule.op) {
    case "eq":  return isArrayVal ? fieldVal.indexOf(rule.value) >= 0 : fieldVal === rule.value;
    case "neq": return isArrayVal ? fieldVal.indexOf(rule.value) < 0  : fieldVal !== rule.value;
    case "contains": {
      // Validator guaranteed an array field; if the catalog row
      // hasn't populated it, treat as empty (not a match).
      if (!isArrayVal) return false;
      return fieldVal.indexOf(rule.value) >= 0;
    }
    case "gt":  return typeof fieldVal === "number" && fieldVal >  rule.value;
    case "gte": return typeof fieldVal === "number" && fieldVal >= rule.value;
    case "lt":  return typeof fieldVal === "number" && fieldVal <  rule.value;
    case "lte": return typeof fieldVal === "number" && fieldVal <= rule.value;
    case "in":
      if (isArrayVal) {
        for (var ai = 0; ai < fieldVal.length; ai += 1) {
          if (rule.value.indexOf(fieldVal[ai]) >= 0) return true;
        }
        return false;
      }
      return rule.value.indexOf(fieldVal) >= 0;
    case "not_in":
      if (isArrayVal) {
        for (var ni = 0; ni < fieldVal.length; ni += 1) {
          if (rule.value.indexOf(fieldVal[ni]) >= 0) return false;
        }
        return true;
      }
      return rule.value.indexOf(fieldVal) < 0;
    case "between": {
      if (typeof fieldVal !== "number") return false;
      return fieldVal >= rule.value[0] && fieldVal <= rule.value[1];
    }
    default:
      // Defensive — the validator should have refused already; if a
      // future op is added in one place but not the other, fail
      // closed rather than silently mismatching.
      throw new TypeError("collections: unknown rule op " + JSON.stringify(rule.op));
  }
}

// Internal short-circuit walker over an already-validated rule set.
function _matchRuleset(rules, product) {
  for (var i = 0; i < rules.all.length; i += 1) {
    if (!_matchRule(rules.all[i], product)) return false;
  }
  if (rules.any.length === 0) return true;
  for (var j = 0; j < rules.any.length; j += 1) {
    if (_matchRule(rules.any[j], product)) return true;
  }
  return false;
}

function _evaluateRules(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("collections.evaluateRules: input object required");
  }
  var rules = _validateRules(input.rules);
  var product = input.product;
  if (product == null || typeof product !== "object") {
    throw new TypeError("collections.evaluateRules: product object required");
  }
  return _matchRuleset(rules, product);
}

// Collect the distinct catalog fields a (validated) rule set reads, so
// the smart-eval path can enrich ONLY the fields a collection actually
// references rather than every supported field on every product. `rules`
// is the `{ all, any }` shape `_validateRules` returns.
function _fieldsReferenced(rules) {
  var seen = Object.create(null);
  function _walk(list) {
    for (var i = 0; i < list.length; i += 1) seen[list[i].field] = true;
  }
  _walk(rules.all);
  _walk(rules.any);
  return Object.keys(seen);
}

// ---- sort comparators for smart collections ------------------------------

// Best-selling needs a sales-rank on the product object; the catalog
// is the source of truth. If the field's absent the comparator
// falls back to id order so the result is still deterministic.
function _smartCompare(strategy) {
  switch (strategy) {
    case "newest":
      return function (a, b) {
        var an = a.created_at || 0;
        var bn = b.created_at || 0;
        if (an !== bn) return bn - an;
        return String(a.id || "").localeCompare(String(b.id || ""));
      };
    case "price_asc":
      return function (a, b) {
        var ap = a.price_minor == null ? Infinity : a.price_minor;
        var bp = b.price_minor == null ? Infinity : b.price_minor;
        if (ap !== bp) return ap - bp;
        return String(a.id || "").localeCompare(String(b.id || ""));
      };
    case "price_desc":
      return function (a, b) {
        var ap = a.price_minor == null ? -Infinity : a.price_minor;
        var bp = b.price_minor == null ? -Infinity : b.price_minor;
        if (ap !== bp) return bp - ap;
        return String(a.id || "").localeCompare(String(b.id || ""));
      };
    case "alphabetical":
      return function (a, b) {
        var at = String(a.title || "").toLowerCase();
        var bt = String(b.title || "").toLowerCase();
        if (at !== bt) return at < bt ? -1 : 1;
        return String(a.id || "").localeCompare(String(b.id || ""));
      };
    case "best_selling":
      return function (a, b) {
        var as = a.sales_rank == null ? 0 : a.sales_rank;
        var bs = b.sales_rank == null ? 0 : b.sales_rank;
        if (as !== bs) return bs - as;
        return String(a.id || "").localeCompare(String(b.id || ""));
      };
    default:
      // Smart collections refuse `manual` upstream; any other
      // strategy that lands here is a code-path bug, not operator
      // input.
      throw new TypeError("collections: smart sort_strategy '" + strategy + "' not supported");
  }
}

// ---- factory -------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var catalog = opts.catalog;
  if (!catalog || !catalog.products || typeof catalog.products.list !== "function") {
    throw new TypeError("collections.create: opts.catalog must expose products.list({ limit, cursor? })");
  }
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("collections.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "collections-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Smart-collection matched-roster cache. A smart collection has no
  // materialised membership — `productsIn` walks the WHOLE catalog,
  // evaluates rules, sorts, then slices the requested page. Paginating
  // a smart collection therefore re-walked the entire catalog on every
  // page request (page 2 redid the work page 1 already did). This brief
  // in-process cache holds the sorted matched roster keyed by the
  // collection's identity + rule fingerprint, so successive page
  // requests within the TTL slice the cached roster instead of
  // re-walking. The TTL is short (a smart collection that just lost a
  // product to an archive shows the stale member for at most one TTL)
  // and configurable; pass `smartCacheTtlMs: 0` to disable. The cache
  // is per-factory-instance and bounded by an LRU-ish cap so it can't
  // grow unbounded across many distinct collections.
  var SMART_CACHE_TTL_MS = opts.smartCacheTtlMs != null
    ? opts.smartCacheTtlMs
    : b.constants.TIME.seconds(30);
  if (typeof SMART_CACHE_TTL_MS !== "number" || !isFinite(SMART_CACHE_TTL_MS) || SMART_CACHE_TTL_MS < 0) {
    throw new TypeError("collections.create: smartCacheTtlMs must be a non-negative number of ms");
  }
  var SMART_CACHE_MAX_ENTRIES = 64;
  var _smartCache = new Map();   // key -> { roster, expires_at }

  function _smartCacheKey(slug, row) {
    // The rule fingerprint + sort_strategy + updated_at are part of the
    // key, so re-defining a smart collection's rules (which bumps
    // updated_at and rewrites rules_json) misses the prior entry and
    // re-walks — no stale roster after an operator edit. NUL joins the
    // parts (it can't appear in a slug, timestamp, sort strategy, or
    // JSON, so the parts can't collide), written as an escape so the
    // source stays plain text.
    return slug + "\u0000" + (row.updated_at == null ? "" : row.updated_at) +
      "\u0000" + (row.sort_strategy || "") + "\u0000" + (row.rules_json || "");
  }

  function _smartCacheGet(key) {
    if (SMART_CACHE_TTL_MS === 0) return null;
    var hit = _smartCache.get(key);
    if (!hit) return null;
    if (hit.expires_at <= _now()) { _smartCache.delete(key); return null; }
    // Refresh LRU recency.
    _smartCache.delete(key);
    _smartCache.set(key, hit);
    return hit.roster;
  }

  function _smartCacheSet(key, roster) {
    if (SMART_CACHE_TTL_MS === 0) return;
    if (_smartCache.size >= SMART_CACHE_MAX_ENTRIES) {
      // Evict the least-recently-used entry (first key in insertion
      // order — `get` re-inserts on hit so live entries drift to the
      // tail).
      var oldest = _smartCache.keys().next().value;
      if (oldest !== undefined) _smartCache.delete(oldest);
    }
    _smartCache.set(key, { roster: roster, expires_at: _now() + SMART_CACHE_TTL_MS });
  }

  // ---- internal helpers --------------------------------------------------

  async function _row(slug) {
    var r = await query("SELECT * FROM collections WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  function _decode(row) {
    if (!row) return null;
    var rules = null;
    if (row.rules_json != null) {
      try { rules = JSON.parse(row.rules_json); }
      catch (_e) {
        // Stored JSON should always parse — the primitive is the
        // only writer. If it doesn't, that's a data-integrity bug
        // the operator needs to see, not a silent null.
        throw new Error("collections: stored rules_json for " + JSON.stringify(row.slug) + " is not valid JSON");
      }
    }
    return {
      slug:           row.slug,
      type:           row.type,
      title:          row.title,
      description:    row.description,
      hero_image_url: row.hero_image_url,
      rules:          rules,
      sort_strategy:  row.sort_strategy,
      archived_at:    row.archived_at,
      created_at:     row.created_at,
      updated_at:     row.updated_at,
    };
  }

  // Walk catalog pages, yielding every non-archived product to the
  // caller-supplied visitor. The catalog is expected to expose
  // `products.list({ limit, cursor?, status? })`; the smart-eval
  // path filters to `status = 'active'` so archived rows never leak
  // into a smart collection. `enrichFields` (optional) is the list of
  // smart-rule fields to join onto each page's rows before the visitor
  // sees them, so the rule evaluator reads real catalog data rather
  // than `undefined` — enrichment is batched per page (one query per
  // referenced supporting table per page, not per product).
  async function _walkCatalogActive(visit, enrichFields) {
    var cursor = null;
    var pages = 0;
    var pageLimit = 200;
    // Safety cap: refuse to walk indefinitely. 200 pages * 200 rows
    // = 40 000 products — the storefront's smart-collection use
    // cases live well below that. A larger catalog needs the
    // operator to pre-materialise membership (out of scope for v1).
    var MAX_PAGES = 200;
    while (pages < MAX_PAGES) {
      var page = await catalog.products.list({ status: "active", limit: pageLimit, cursor: cursor });
      var rows = (page && page.rows) || [];
      if (enrichFields && enrichFields.length) await _enrichRows(rows, enrichFields);
      for (var i = 0; i < rows.length; i += 1) await visit(rows[i]);
      cursor = (page && page.next_cursor) || null;
      pages += 1;
      if (!cursor) return;
    }
    throw new Error("collections: catalog walk exceeded " + MAX_PAGES + " pages — pre-materialise smart membership");
  }

  // ---- smart-rule field enrichment --------------------------------------

  // The catalog's `products.list` returns the bare product row — id,
  // slug, title, description, status, created_at, updated_at. A smart
  // collection's rules read `tags`, `category`, `vendor`, `price_minor`,
  // and `inventory_count`, none of which live on that row; they're
  // joined from supporting tables (`product_tags`, `product_categories`,
  // `vendor_skus` via `variants.sku`, `prices`, `inventory`). Without
  // this enrichment every rule on those fields evaluated against
  // `undefined` and a smart collection matched ZERO products in
  // production while the unit-test mock (which pre-stuffs the fields)
  // stayed green — a dark feature.
  //
  // Enrichment is batched per catalog page and scoped to ONLY the fields
  // the active rule set references (computed once by the caller), so a
  // collection that filters on price alone never pays for the tag /
  // category / vendor joins. A row that ALREADY carries a field (e.g. a
  // caller that pre-decorated, or the test mock) is left untouched — the
  // enrichment only fills gaps. Each supporting-table read is wrapped so
  // an unmigrated table degrades the field to its empty form (empty
  // array / null / 0) rather than throwing out of the catalog walk.
  async function _enrichRows(rows, fields) {
    if (!rows.length || !fields.length) return;
    var need = {};
    for (var f = 0; f < fields.length; f += 1) need[fields[f]] = true;

    // Only enrich product rows that are MISSING the requested field —
    // gather their ids per field so a pre-decorated row is never
    // re-queried.
    var ids = [];
    var idSeen = Object.create(null);
    for (var i = 0; i < rows.length; i += 1) {
      var id = rows[i] && rows[i].id;
      if (id == null) continue;
      if (!idSeen[id]) { idSeen[id] = true; ids.push(id); }
    }
    if (!ids.length) return;
    var ph = ids.map(function (_v, n) { return "?" + (n + 1); }).join(",");

    async function _safeQuery(sql, params) {
      try { return (await query(sql, params)).rows; }
      catch (_e) { return []; }   // unmigrated supporting table → empty
    }

    var tagsByProduct = null;
    if (need.tags) {
      tagsByProduct = Object.create(null);
      var tagRows = await _safeQuery(
        "SELECT product_id, tag FROM product_tags WHERE product_id IN (" + ph + ")",
        ids,
      );
      for (var t = 0; t < tagRows.length; t += 1) {
        var tp = tagRows[t].product_id;
        (tagsByProduct[tp] || (tagsByProduct[tp] = [])).push(tagRows[t].tag);
      }
    }

    var catByProduct = null;
    if (need.category) {
      catByProduct = Object.create(null);
      var catRows = await _safeQuery(
        "SELECT product_id, category FROM product_categories WHERE product_id IN (" + ph + ")",
        ids,
      );
      for (var c = 0; c < catRows.length; c += 1) {
        var cp = catRows[c].product_id;
        (catByProduct[cp] || (catByProduct[cp] = [])).push(catRows[c].category);
      }
    }

    var vendorByProduct = null;
    if (need.vendor) {
      vendorByProduct = Object.create(null);
      // Vendor binds to a SKU (vendor_skus.sku), and a SKU belongs to a
      // variant of a product. A product with several variants could in
      // principle map to more than one vendor; the smart-rule field is
      // scalar, so we take the lexicographically-smallest assigned
      // vendor slug for determinism. Products with no assigned vendor
      // get null (no row), and the rule on `vendor` simply won't match.
      var venRows = await _safeQuery(
        "SELECT v.product_id AS product_id, MIN(vs.vendor_slug) AS vendor " +
        "FROM variants v JOIN vendor_skus vs ON vs.sku = v.sku " +
        "WHERE v.product_id IN (" + ph + ") GROUP BY v.product_id",
        ids,
      );
      for (var vi = 0; vi < venRows.length; vi += 1) {
        vendorByProduct[venRows[vi].product_id] = venRows[vi].vendor;
      }
    }

    var priceByProduct = null;
    if (need.price_minor) {
      priceByProduct = Object.create(null);
      // Lowest CURRENT price across the product's variants — the
      // `effective_until IS NULL` row is the live price the catalog's
      // own decorator reads. "Starting at" is the natural price a
      // price-bounded smart rule (`price_minor < 5000`) should test.
      var priceRows = await _safeQuery(
        "SELECT v.product_id AS product_id, MIN(pr.amount_minor) AS price_minor " +
        "FROM variants v JOIN prices pr ON pr.variant_id = v.id " +
        "WHERE v.product_id IN (" + ph + ") AND pr.effective_until IS NULL " +
        "GROUP BY v.product_id",
        ids,
      );
      for (var pi = 0; pi < priceRows.length; pi += 1) {
        priceByProduct[priceRows[pi].product_id] = priceRows[pi].price_minor;
      }
    }

    var invByProduct = null;
    if (need.inventory_count) {
      invByProduct = Object.create(null);
      // Total on-hand units across the product's variant SKUs. A rule
      // like `inventory_count > 0` ("only in-stock") reads this.
      var invRows = await _safeQuery(
        "SELECT v.product_id AS product_id, COALESCE(SUM(inv.stock_on_hand), 0) AS inventory_count " +
        "FROM variants v JOIN inventory inv ON inv.sku = v.sku " +
        "WHERE v.product_id IN (" + ph + ") GROUP BY v.product_id",
        ids,
      );
      for (var ii = 0; ii < invRows.length; ii += 1) {
        invByProduct[invRows[ii].product_id] = invRows[ii].inventory_count;
      }
    }

    for (var r = 0; r < rows.length; r += 1) {
      var row = rows[r];
      var rid = row && row.id;
      if (rid == null) continue;
      if (need.tags && !("tags" in row)) row.tags = tagsByProduct[rid] || [];
      if (need.category && !("category" in row)) row.category = catByProduct[rid] || [];
      if (need.vendor && !("vendor" in row)) {
        row.vendor = Object.prototype.hasOwnProperty.call(vendorByProduct, rid) ? vendorByProduct[rid] : null;
      }
      if (need.price_minor && !("price_minor" in row)) {
        row.price_minor = Object.prototype.hasOwnProperty.call(priceByProduct, rid) ? priceByProduct[rid] : null;
      }
      if (need.inventory_count && !("inventory_count" in row)) {
        row.inventory_count = Object.prototype.hasOwnProperty.call(invByProduct, rid) ? invByProduct[rid] : 0;
      }
    }
  }

  // ---- defineManual ------------------------------------------------------

  async function defineManual(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("collections.defineManual: input object required");
    }
    _slug(input.slug);
    _title(input.title);
    var description = _description(input.description);
    var heroUrl     = _heroUrl(input.hero_image_url);
    var sortStrategy = input.sort_strategy == null ? "manual" : input.sort_strategy;
    _sortStrategy(sortStrategy, "manual");

    var existing = await _row(input.slug);
    if (existing) {
      throw new TypeError("collections.defineManual: slug " + JSON.stringify(input.slug) + " already exists");
    }
    var ts = _now();
    await query(
      "INSERT INTO collections (slug, type, title, description, hero_image_url, rules_json, sort_strategy, archived_at, created_at, updated_at) " +
      "VALUES (?1, 'manual', ?2, ?3, ?4, NULL, ?5, NULL, ?6, ?6)",
      [input.slug, input.title, description, heroUrl, sortStrategy, ts],
    );
    return await get(input.slug);
  }

  // ---- defineSmart -------------------------------------------------------

  async function defineSmart(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("collections.defineSmart: input object required");
    }
    _slug(input.slug);
    _title(input.title);
    var description = _description(input.description);
    var heroUrl     = _heroUrl(input.hero_image_url);
    var rules = _validateRules(input.rules);
    if (typeof input.sort_strategy !== "string") {
      throw new TypeError("collections.defineSmart: sort_strategy is required");
    }
    _sortStrategy(input.sort_strategy, "smart");

    var existing = await _row(input.slug);
    if (existing) {
      throw new TypeError("collections.defineSmart: slug " + JSON.stringify(input.slug) + " already exists");
    }
    var ts = _now();
    await query(
      "INSERT INTO collections (slug, type, title, description, hero_image_url, rules_json, sort_strategy, archived_at, created_at, updated_at) " +
      "VALUES (?1, 'smart', ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
      [input.slug, input.title, description, heroUrl, JSON.stringify(rules), input.sort_strategy, ts],
    );
    return await get(input.slug);
  }

  // ---- get / list --------------------------------------------------------

  async function get(slug) {
    _slug(slug);
    return _decode(await _row(slug));
  }

  async function list(input) {
    input = input || {};
    var sql;
    if (input.active_only === true) {
      sql = "SELECT * FROM collections WHERE archived_at IS NULL ORDER BY updated_at DESC, slug DESC";
    } else if (input.archived_only === true) {
      sql = "SELECT * FROM collections WHERE archived_at IS NOT NULL ORDER BY updated_at DESC, slug DESC";
    } else {
      sql = "SELECT * FROM collections ORDER BY updated_at DESC, slug DESC";
    }
    var r = await query(sql, []);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decode(r.rows[i]));
    return out;
  }

  // ---- update ------------------------------------------------------------

  async function update(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("collections.update: patch object required");
    }
    var existing = await _row(slug);
    if (!existing) return null;

    var sets = [];
    var params = [];
    var idx = 1;
    function _addSet(col, val) {
      b.safeSql.assertOneOf(col, ALLOWED_COLUMNS);
      sets.push(b.safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (idx++));
      params.push(val);
    }
    if (patch.title !== undefined) {
      _title(patch.title);
      _addSet("title", patch.title);
    }
    if (patch.description !== undefined) {
      _addSet("description", _description(patch.description));
    }
    if (patch.hero_image_url !== undefined) {
      _addSet("hero_image_url", _heroUrl(patch.hero_image_url));
    }
    if (patch.sort_strategy !== undefined) {
      _sortStrategy(patch.sort_strategy, existing.type);
      _addSet("sort_strategy", patch.sort_strategy);
    }
    var rulesPatch = null;
    if (patch.rules !== undefined) {
      if (existing.type !== "smart") {
        throw new TypeError("collections.update: rules patch is only valid for smart collections");
      }
      rulesPatch = _validateRules(patch.rules);
    }
    if (sets.length === 0 && rulesPatch === null) {
      throw new TypeError("collections.update: patch contained no updatable fields");
    }
    var ts = _now();
    if (sets.length > 0) {
      sets.push("updated_at = ?" + (idx++));
      params.push(ts);
      params.push(slug);
      await query(
        "UPDATE collections SET " + sets.join(", ") + " WHERE slug = ?" + idx,
        params,
      );
    }
    if (rulesPatch !== null) {
      await query(
        "UPDATE collections SET rules_json = ?1, updated_at = ?2 WHERE slug = ?3",
        [JSON.stringify(rulesPatch), ts, slug],
      );
    }
    return await get(slug);
  }

  // ---- archive -----------------------------------------------------------

  async function archive(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE collections SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (r.rowCount === 0) {
      // Either the row is missing or already archived. Disambiguate
      // so the caller knows which.
      var existing = await _row(slug);
      if (!existing) return null;
      return _decode(existing);
    }
    return await get(slug);
  }

  // ---- membership writes (manual only) ----------------------------------

  function _assertManual(row, fn, slug) {
    if (row.type !== "manual") {
      throw new TypeError("collections." + fn + ": " + JSON.stringify(slug) +
                          " is a smart collection — membership is rule-evaluated, not curated");
    }
  }

  async function addProduct(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("collections.addProduct: input object required");
    }
    _slug(input.collection_slug);
    var productId = _productId(input.product_id, "product_id");
    var row = await _row(input.collection_slug);
    if (!row) throw new TypeError("collections.addProduct: collection " + JSON.stringify(input.collection_slug) + " not found");
    _assertManual(row, "addProduct", input.collection_slug);
    if (row.archived_at != null) {
      throw new TypeError("collections.addProduct: collection " + JSON.stringify(input.collection_slug) + " is archived");
    }
    // Refuse duplicate add — the UNIQUE index would refuse it
    // anyway, but a clean TypeError is easier on the calling
    // handler than an opaque SQLITE_CONSTRAINT.
    var dup = await query(
      "SELECT id FROM collection_members WHERE collection_slug = ?1 AND product_id = ?2",
      [input.collection_slug, productId],
    );
    if (dup.rows.length > 0) {
      throw new TypeError("collections.addProduct: product " + JSON.stringify(productId) +
                          " is already a member of " + JSON.stringify(input.collection_slug));
    }
    var position;
    if (input.position == null) {
      // Append at the tail. Read max(position) and add 1 so the new
      // row sorts last.
      var maxRow = await query(
        "SELECT MAX(position) AS max_pos FROM collection_members WHERE collection_slug = ?1",
        [input.collection_slug],
      );
      var maxPos = maxRow.rows[0] && maxRow.rows[0].max_pos;
      position = (maxPos == null ? -1 : maxPos) + 1;
    } else {
      if (!Number.isInteger(input.position) || input.position < 0) {
        throw new TypeError("collections.addProduct: position must be a non-negative integer or null");
      }
      position = input.position;
    }
    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO collection_members (id, collection_slug, product_id, position, added_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [id, input.collection_slug, productId, position, ts],
    );
    // Bump parent updated_at so cursor pagination on the
    // collections list reflects the membership change.
    await query("UPDATE collections SET updated_at = ?1 WHERE slug = ?2", [ts, input.collection_slug]);
    return { id: id, collection_slug: input.collection_slug, product_id: productId, position: position, added_at: ts };
  }

  async function removeProduct(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("collections.removeProduct: input object required");
    }
    _slug(input.collection_slug);
    var productId = _productId(input.product_id, "product_id");
    var row = await _row(input.collection_slug);
    if (!row) throw new TypeError("collections.removeProduct: collection " + JSON.stringify(input.collection_slug) + " not found");
    _assertManual(row, "removeProduct", input.collection_slug);
    var r = await query(
      "DELETE FROM collection_members WHERE collection_slug = ?1 AND product_id = ?2",
      [input.collection_slug, productId],
    );
    if (r.rowCount > 0) {
      await query("UPDATE collections SET updated_at = ?1 WHERE slug = ?2", [_now(), input.collection_slug]);
    }
    return r.rowCount > 0;
  }

  async function reorderProducts(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("collections.reorderProducts: input object required");
    }
    _slug(input.collection_slug);
    if (!Array.isArray(input.ordered_product_ids)) {
      throw new TypeError("collections.reorderProducts: ordered_product_ids must be an array");
    }
    var row = await _row(input.collection_slug);
    if (!row) throw new TypeError("collections.reorderProducts: collection " + JSON.stringify(input.collection_slug) + " not found");
    _assertManual(row, "reorderProducts", input.collection_slug);

    // Validate every id shape + dedupe before touching the DB.
    var seen = Object.create(null);
    var ids = [];
    for (var i = 0; i < input.ordered_product_ids.length; i += 1) {
      var pid = _productId(input.ordered_product_ids[i], "ordered_product_ids[" + i + "]");
      if (seen[pid]) {
        throw new TypeError("collections.reorderProducts: duplicate product_id " + JSON.stringify(pid));
      }
      seen[pid] = true;
      ids.push(pid);
    }

    // Confirm the supplied ids exactly match the current membership
    // set — partial reorders would leave positions ambiguous and
    // are easier to refuse cleanly than to coerce.
    var memberRows = await query(
      "SELECT product_id FROM collection_members WHERE collection_slug = ?1",
      [input.collection_slug],
    );
    var have = Object.create(null);
    for (var m = 0; m < memberRows.rows.length; m += 1) have[memberRows.rows[m].product_id] = true;
    if (memberRows.rows.length !== ids.length) {
      throw new TypeError("collections.reorderProducts: ordered_product_ids must list every current member (" +
                          memberRows.rows.length + " expected, " + ids.length + " supplied)");
    }
    for (var k = 0; k < ids.length; k += 1) {
      if (!have[ids[k]]) {
        throw new TypeError("collections.reorderProducts: product_id " + JSON.stringify(ids[k]) +
                            " is not a member of " + JSON.stringify(input.collection_slug));
      }
    }

    // Densely rewrite positions to 0..N-1. The position column is
    // operator-controlled but the primitive normalises it so cursor
    // pagination on (position, id) stays stable.
    for (var p = 0; p < ids.length; p += 1) {
      await query(
        "UPDATE collection_members SET position = ?1 WHERE collection_slug = ?2 AND product_id = ?3",
        [p, input.collection_slug, ids[p]],
      );
    }
    await query("UPDATE collections SET updated_at = ?1 WHERE slug = ?2", [_now(), input.collection_slug]);
    return true;
  }

  // ---- productsIn --------------------------------------------------------

  async function productsIn(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("collections.productsIn: input object required");
    }
    _slug(input.slug);
    var limit = input.limit == null ? DEFAULT_LIMIT : input.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      throw new TypeError("collections.productsIn: limit must be 1..." + MAX_LIMIT);
    }
    var row = await _row(input.slug);
    if (!row) throw new TypeError("collections.productsIn: collection " + JSON.stringify(input.slug) + " not found");

    if (row.type === "manual") {
      var cursorVals = null;
      if (input.cursor != null) {
        if (typeof input.cursor !== "string") {
          throw new TypeError("collections.productsIn: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(input.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(MEMBER_ORDER_KEY)) {
            throw new TypeError("collections.productsIn: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("collections.productsIn: cursor — " + (e && e.message || "malformed"));
        }
      }
      // Fetch one row beyond the page so the next cursor is emitted ONLY
      // when a member past this page actually exists. Keying the cursor off
      // a full page alone (rows.length === limit) advertises a phantom next
      // page when the collection size is an exact multiple of the limit —
      // following it lands on an empty page. The smart path peeks the same
      // way (startIdx + slice.length < matched.length).
      var sql, params;
      if (cursorVals) {
        sql = "SELECT * FROM collection_members WHERE collection_slug = ?1 AND " +
              "(position > ?2 OR (position = ?2 AND id > ?3)) " +
              "ORDER BY position ASC, id ASC LIMIT ?4";
        params = [input.slug, cursorVals[0], cursorVals[1], limit + 1];
      } else {
        sql = "SELECT * FROM collection_members WHERE collection_slug = ?1 " +
              "ORDER BY position ASC, id ASC LIMIT ?2";
        params = [input.slug, limit + 1];
      }
      var r = await query(sql, params);
      var hasMore = r.rows.length > limit;
      var pageRows = hasMore ? r.rows.slice(0, limit) : r.rows;
      var lastM = pageRows[pageRows.length - 1];
      var nextM = null;
      if (lastM && hasMore) {
        nextM = b.pagination.encodeCursor({
          orderKey: MEMBER_ORDER_KEY,
          vals:     [lastM.position, lastM.id],
          forward:  true,
        }, cursorSecret);
      }
      return {
        type: "manual",
        sort_strategy: row.sort_strategy,
        rows: pageRows.map(function (mr) {
          return {
            id:                mr.id,
            collection_slug:   mr.collection_slug,
            product_id:        mr.product_id,
            position:          mr.position,
            added_at:          mr.added_at,
          };
        }),
        next_cursor: nextM,
      };
    }

    // Smart path: walk the catalog and evaluate rules. The cursor
    // is a hash-tagged offset into the in-memory matched list; for
    // a smart collection there's no SQL keyset because the order is
    // dictated by `sort_strategy` and the rule evaluator runs
    // application-side.
    var rules = JSON.parse(row.rules_json);
    var startIdx = 0;
    if (input.cursor != null) {
      if (typeof input.cursor !== "string") {
        throw new TypeError("collections.productsIn: cursor must be an opaque string or null");
      }
      try {
        var sstate = b.pagination.decodeCursor(input.cursor, cursorSecret);
        if (JSON.stringify(sstate.orderKey) !== JSON.stringify(SMART_ORDER_KEY)) {
          throw new TypeError("collections.productsIn: cursor orderKey mismatch");
        }
        startIdx = sstate.vals[0];
        if (!Number.isInteger(startIdx) || startIdx < 0) {
          throw new TypeError("collections.productsIn: cursor offset must be a non-negative integer");
        }
      } catch (e2) {
        if (e2 instanceof TypeError) throw e2;
        throw new TypeError("collections.productsIn: cursor — " + (e2 && e2.message || "malformed"));
      }
    }

    // Reuse the cached sorted roster when a recent page request already
    // walked + sorted this exact (slug, rules, sort, updated_at)
    // combination; otherwise walk the catalog once, sort, and cache.
    // Paginating no longer re-walks the whole catalog per page.
    var cacheKey = _smartCacheKey(input.slug, row);
    var matched = _smartCacheGet(cacheKey);
    if (matched == null) {
      var enrichFields = _fieldsReferenced(rules);
      matched = [];
      await _walkCatalogActive(function (product) {
        if (_matchRuleset(rules, product)) matched.push(product);
      }, enrichFields);
      var sortStrategy = row.sort_strategy === "manual" ? "newest" : row.sort_strategy;
      matched.sort(_smartCompare(sortStrategy));
      _smartCacheSet(cacheKey, matched);
    }
    var slice = matched.slice(startIdx, startIdx + limit);
    var nextS = null;
    if (startIdx + slice.length < matched.length) {
      nextS = b.pagination.encodeCursor({
        orderKey: SMART_ORDER_KEY,
        vals:     [startIdx + slice.length],
        forward:  true,
      }, cursorSecret);
    }
    return {
      type: "smart",
      sort_strategy: row.sort_strategy,
      rows: slice,
      next_cursor: nextS,
    };
  }

  // ---- collectionsForProduct --------------------------------------------

  async function collectionsForProduct(productId) {
    var pid = _productId(productId, "product_id");
    // Manual membership: a single indexed lookup.
    var manualRows = await query(
      "SELECT c.* FROM collections c " +
      "JOIN collection_members m ON m.collection_slug = c.slug " +
      "WHERE m.product_id = ?1 AND c.archived_at IS NULL " +
      "ORDER BY c.updated_at DESC, c.slug DESC",
      [pid],
    );
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < manualRows.rows.length; i += 1) {
      var dec = _decode(manualRows.rows[i]);
      out.push(dec);
      seen[dec.slug] = true;
    }
    // Smart membership: every active smart collection's rules
    // evaluated against the supplied product. To preserve the pure
    // separation between this primitive and the catalog, we need
    // the product object itself — fetch via catalog.products.get
    // if available, otherwise skip smart matches (a catalog without
    // `get` can still drive manual collections).
    if (typeof catalog.products.get === "function") {
      var product = await catalog.products.get(pid);
      if (product) {
        var smartRows = await query(
          "SELECT * FROM collections WHERE type = 'smart' AND archived_at IS NULL",
          [],
        );
        // Parse every active smart rule set once, collecting the UNION
        // of catalog fields they read so the single product can be
        // enriched with real tag / category / vendor / price /
        // inventory data in one batch before any rule evaluates —
        // mirroring the productsIn smart path. Without this the reverse
        // lookup matched zero smart collections for the same dark-feature
        // reason the forward path did.
        var parsed = [];
        var fieldSeen = Object.create(null);
        for (var s = 0; s < smartRows.rows.length; s += 1) {
          if (seen[smartRows.rows[s].slug]) continue;
          var rules;
          try { rules = JSON.parse(smartRows.rows[s].rules_json); }
          catch (_e) { continue; }
          parsed.push({ row: smartRows.rows[s], rules: rules });
          var refs = _fieldsReferenced(rules);
          for (var rf = 0; rf < refs.length; rf += 1) fieldSeen[refs[rf]] = true;
        }
        await _enrichRows([product], Object.keys(fieldSeen));
        for (var pj = 0; pj < parsed.length; pj += 1) {
          if (_matchRuleset(parsed[pj].rules, product)) out.push(_decode(parsed[pj].row));
        }
      }
    }
    return out;
  }

  // ---- countIn -----------------------------------------------------------

  // The current size of a collection, cheaply. For a MANUAL collection
  // this is an exact `COUNT(*)` over `collection_members` — one indexed
  // aggregate, no row materialisation (the admin list previously pulled
  // up to 200 member rows just to `.length` them). For a SMART collection
  // there is no cheap SQL count (membership is rule-evaluated against the
  // catalog application-side), so the bounded preview is kept: it walks
  // the same matched set `productsIn` does, capped at MAX_LIMIT, and the
  // result is labelled a preview.
  //
  // Returns `{ exact: n }` for manual (a true total) and `{ approx: n }`
  // for smart (the bounded preview, ≤ MAX_LIMIT). The caller reads
  // whichever key is present; the number shown is unchanged from the
  // previous `productsIn(...).rows.length` for both flavours.
  async function countIn(slug) {
    _slug(slug);
    var row = await _row(slug);
    if (!row) throw new TypeError("collections.countIn: collection " + JSON.stringify(slug) + " not found");
    if (row.type === "manual") {
      var r = await query(
        "SELECT COUNT(*) AS n FROM collection_members WHERE collection_slug = ?1",
        [slug],
      );
      var n = r.rows[0] && r.rows[0].n;
      return { exact: Number(n == null ? 0 : n) };
    }
    // Smart: the bounded preview — same matched set productsIn returns,
    // capped at MAX_LIMIT (the cap the admin list already used).
    var preview = await productsIn({ slug: slug, limit: MAX_LIMIT });
    return { approx: (preview.rows || []).length };
  }

  return {
    defineManual:           defineManual,
    defineSmart:            defineSmart,
    get:                    get,
    list:                   list,
    update:                 update,
    archive:                archive,
    addProduct:             addProduct,
    removeProduct:          removeProduct,
    reorderProducts:        reorderProducts,
    productsIn:             productsIn,
    countIn:                countIn,
    collectionsForProduct:  collectionsForProduct,
    evaluateRules:          _evaluateRules,
  };
}

module.exports = {
  create:           create,
  COLLECTION_TYPES: COLLECTION_TYPES,
  SORT_STRATEGIES:  SORT_STRATEGIES,
  RULE_FIELDS:      RULE_FIELDS,
  RULE_OPS:         RULE_OPS,
  ALLOWED_COLUMNS:  ALLOWED_COLUMNS,
};
