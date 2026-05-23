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
 *     - `list({ active_only? })`
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

var bShop;
function _b() {
  // Lazy so unit tests can require this module without first
  // initialising the vendored blamejs tree — they pass their own
  // `query` + `catalog` handles and never touch the runtime
  // singleton.
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

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
    return _b().guardUuid.sanitize(s, { profile: "strict" });
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
  switch (rule.op) {
    case "eq":  return fieldVal === rule.value;
    case "neq": return fieldVal !== rule.value;
    case "contains": {
      // Validator guaranteed an array field; if the catalog row
      // hasn't populated it, treat as empty (not a match).
      if (!Array.isArray(fieldVal)) return false;
      return fieldVal.indexOf(rule.value) >= 0;
    }
    case "gt":  return typeof fieldVal === "number" && fieldVal >  rule.value;
    case "gte": return typeof fieldVal === "number" && fieldVal >= rule.value;
    case "lt":  return typeof fieldVal === "number" && fieldVal <  rule.value;
    case "lte": return typeof fieldVal === "number" && fieldVal <= rule.value;
    case "in":  return rule.value.indexOf(fieldVal) >= 0;
    case "not_in": return rule.value.indexOf(fieldVal) < 0;
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
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
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
  // into a smart collection.
  async function _walkCatalogActive(visit) {
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
      for (var i = 0; i < rows.length; i += 1) await visit(rows[i]);
      cursor = (page && page.next_cursor) || null;
      pages += 1;
      if (!cursor) return;
    }
    throw new Error("collections: catalog walk exceeded " + MAX_PAGES + " pages — pre-materialise smart membership");
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
    var activeOnly = input.active_only === true;
    var sql;
    if (activeOnly) {
      sql = "SELECT * FROM collections WHERE archived_at IS NULL ORDER BY updated_at DESC, slug DESC";
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
      _b().safeSql.assertOneOf(col, ALLOWED_COLUMNS);
      sets.push(_b().safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (idx++));
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
    var id = _b().uuid.v7();
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
          var state = _b().pagination.decodeCursor(input.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(MEMBER_ORDER_KEY)) {
            throw new TypeError("collections.productsIn: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("collections.productsIn: cursor — " + (e && e.message || "malformed"));
        }
      }
      var sql, params;
      if (cursorVals) {
        sql = "SELECT * FROM collection_members WHERE collection_slug = ?1 AND " +
              "(position > ?2 OR (position = ?2 AND id > ?3)) " +
              "ORDER BY position ASC, id ASC LIMIT ?4";
        params = [input.slug, cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM collection_members WHERE collection_slug = ?1 " +
              "ORDER BY position ASC, id ASC LIMIT ?2";
        params = [input.slug, limit];
      }
      var r = await query(sql, params);
      var lastM = r.rows[r.rows.length - 1];
      var nextM = null;
      if (lastM && r.rows.length === limit) {
        nextM = _b().pagination.encodeCursor({
          orderKey: MEMBER_ORDER_KEY,
          vals:     [lastM.position, lastM.id],
          forward:  true,
        }, cursorSecret);
      }
      return {
        type: "manual",
        sort_strategy: row.sort_strategy,
        rows: r.rows.map(function (mr) {
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
        var sstate = _b().pagination.decodeCursor(input.cursor, cursorSecret);
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

    var matched = [];
    await _walkCatalogActive(function (product) {
      if (_matchRuleset(rules, product)) matched.push(product);
    });
    var sortStrategy = row.sort_strategy === "manual" ? "newest" : row.sort_strategy;
    matched.sort(_smartCompare(sortStrategy));
    var slice = matched.slice(startIdx, startIdx + limit);
    var nextS = null;
    if (startIdx + slice.length < matched.length) {
      nextS = _b().pagination.encodeCursor({
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
        for (var s = 0; s < smartRows.rows.length; s += 1) {
          if (seen[smartRows.rows[s].slug]) continue;
          var rules;
          try { rules = JSON.parse(smartRows.rows[s].rules_json); }
          catch (_e) { continue; }
          if (_matchRuleset(rules, product)) out.push(_decode(smartRows.rows[s]));
        }
      }
    }
    return out;
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
