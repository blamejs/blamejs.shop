"use strict";
/**
 * @module shop.catalog
 * @title  Catalog primitive — products, variants, prices, inventory, media
 *
 * @intro
 *   v1-defensible catalog surface composed on top of `b.externalDb`.
 *   Five sub-modules:
 *
 *   - `products`   — create, get, bySlug, list, update, archive, restore
 *   - `variants`   — create, get, listForProduct, update, delete
 *   - `prices`     — set (versioned), current, history
 *   - `inventory`  — create, get, list, hold, decrement, release,
 *                    restock, setThreshold, checkLowStock
 *   - `media`      — attach, get, listForProduct, listForVariant, delete,
 *                    reorder, setPrimary
 *
 *   Every write validates input at entry; bad input throws TypeError
 *   with a descriptive message so the calling route handler can
 *   convert to HTTP 400. Reads return plain objects shaped to the
 *   table columns (no field renames — keeps the SQL→JS mapping
 *   trivial to audit).
 *
 *   The module exposes a `create()` factory so the tests can inject a
 *   query function bound to an in-memory SQLite, exercising the same
 *   SQL the live D1 sees. Default at runtime: `b.externalDb.query`
 *   against the configured backend.
 *
 *       var bShop = require("blamejs-shop");
 *       var catalog = bShop.catalog.create();   // uses b.externalDb default
 *       var p = await catalog.products.create({
 *         slug: "widget-pro",
 *         title: "Widget Pro",
 *         status: "active",
 *       });
 *       var v = await catalog.variants.create(p.id, {
 *         sku: "WDG-PRO-BLK-L",
 *         options: { color: "black", size: "L" },
 *         weight_grams: 250,
 *       });
 *       await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2999 });
 *       await catalog.inventory.create(v.sku, { stock_on_hand: 100 });
 */

var b = require("./vendor/blamejs");

var PRODUCT_STATUSES = Object.freeze(["draft", "active", "archived"]);
var SLUG_RE          = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;
var SKU_RE           = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CURRENCY_RE      = /^[A-Z]{3}$/;
var MAX_TITLE_LEN    = 500;
var MAX_DESC_LEN     = 100000;
var MAX_ALT_LEN      = 500;
var MAX_R2KEY_LEN    = 1024;
var MAX_LIMIT        = 200;
var MAX_SEARCH_Q_LEN = 200;

// Columns each *update() function may touch. Locked down via
// b.safeSql.assertOneOf so a future change introducing a dynamic
// patch key path can't accidentally widen the surface to an
// attacker-controlled column name.
var ALLOWED_PRODUCT_COLUMNS = Object.freeze(["slug", "title", "description", "status"]);
var ALLOWED_VARIANT_COLUMNS = Object.freeze(["sku", "title", "options_json", "weight_grams", "requires_shipping", "position"]);

// ---- validators ----------------------------------------------------------

// UUIDs go through b.guardUuid (RFC 9562, threat catalog includes
// nil/max sentinels, brace smuggling, URN prefix, BIDI/control bytes,
// non-RFC variants). Strict profile refuses every issue at high or
// critical severity. Returns the canonical hyphenated lowercase form.
function _id(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("catalog: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}
function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("catalog: slug must match /^[a-z0-9][a-z0-9-]*[a-z0-9]?$/ (lowercase alnum + hyphen, ≤ 200 chars)");
  }
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("catalog: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, ≤ 128 chars)");
  }
}
function _title(s, label) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("catalog: " + label + " must be a non-empty string ≤ " + MAX_TITLE_LEN + " chars");
  }
}
function _description(s) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > MAX_DESC_LEN) {
    throw new TypeError("catalog: description must be a string ≤ " + MAX_DESC_LEN + " chars");
  }
  return s;
}
function _status(s) {
  if (PRODUCT_STATUSES.indexOf(s) === -1) {
    throw new TypeError("catalog: status must be one of " + PRODUCT_STATUSES.join(", ") + ", got " + JSON.stringify(s));
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("catalog: " + label + " must be a non-negative integer");
  }
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("catalog: " + label + " must be a positive integer");
  }
}
function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("catalog: currency must be a 3-letter ISO 4217 code (uppercase), got " + JSON.stringify(s));
  }
}
function _options(o) {
  if (o == null) return "{}";
  if (typeof o !== "object" || Array.isArray(o)) {
    throw new TypeError("catalog: options must be a plain object (variant attribute map)");
  }
  // Round-trip through JSON to ensure serializable + canonical
  // ordering doesn't matter (JSON.stringify is deterministic only
  // for primitives at the top level; we don't depend on order for
  // equality, only on round-trip preservation).
  var str = JSON.stringify(o);
  if (str.length > 10000) {
    throw new TypeError("catalog: options json must serialize to ≤ 10000 chars");
  }
  return str;
}
function _bool(b, label) {
  if (typeof b !== "boolean") {
    throw new TypeError("catalog: " + label + " must be a boolean");
  }
  return b ? 1 : 0;
}
function _altText(s) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > MAX_ALT_LEN) {
    throw new TypeError("catalog: alt_text must be a string ≤ " + MAX_ALT_LEN + " chars");
  }
  return s;
}
function _r2Key(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_R2KEY_LEN) {
    throw new TypeError("catalog: r2_key must be a non-empty string ≤ " + MAX_R2KEY_LEN + " chars");
  }
  if (s.indexOf("..") !== -1 || s.charCodeAt(0) === 47) {
    throw new TypeError("catalog: r2_key must not contain '..' or begin with '/'");
  }
}
// Content-type goes through b.guardMime (RFC 6838 grammar + refuses
// risky types like application/x-msdownload, x-sh, x-csh,
// application/javascript / text/javascript for non-script contexts,
// plus BIDI/control/null-byte smuggling).
function _contentType(s) {
  try {
    return b.guardMime.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("catalog: content_type — " + (e && e.message || "invalid MIME"));
  }
}

// IDs come from b.uuid.v7 (RFC 9562 v7 — millisecond-prefixed,
// lexicographically sortable → B-tree-locality wins on PKs whose
// insert pattern is "newest at the end"). Native randomUUID is v4
// random; we want v7 for catalog PKs.
function _genId() { return b.uuid.v7(); }
function _now()   { return Date.now(); }

// Build the LIKE pattern for a single term — lowercased + the
// `\`-first metacharacter neutralisation so a term containing `%` /
// `_` matches only the literal character (otherwise `100%` would
// match every row). The `\\` substitution MUST run first, before the
// `%` / `_` passes, so the `\` we insert in front of a wildcard
// isn't itself re-escaped on the next pass and the wildcard survives
// un-neutralised. `products.search` and `batch.searchDecorate` both
// compose this so the escape can't drift between the two surfaces;
// it mirrors the edge `_likePattern` (worker/data/catalog.js).
function _likePattern(term) {
  var escaped = String(term).toLowerCase()
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  return "%" + escaped + "%";
}

// ---- factory -------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    // Bind at runtime so b.externalDb is initialized by createApp
    // before any route fires (the factory call inside server.js
    // happens at boot, but the closure resolves lazily on first
    // catalog op).
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors are HMAC-tagged via b.pagination so an
  // operator can't hand-craft a cursor to skip ahead or smuggle
  // injected SQL through the tuple. The secret must be stable for
  // the deployment (rotating it invalidates outstanding cursors —
  // acceptable). Operators provide via opts.cursorSecret; tests
  // default to a fixed string.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("catalog.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "catalog-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  var products  = _productsModule(query, cursorSecret);
  var variants  = _variantsModule(query);
  var prices    = _pricesModule(query);
  // `onStockChange(sku)` fires after every stock-mutating inventory
  // op so the optional alerts primitive can decide whether to
  // emit a low-stock signal. The callback is drop-silent — alert
  // failure never rolls back the stock op that triggered it.
  var inventory = _inventoryModule(query, { onStockChange: opts.onStockChange || null });
  var media     = _mediaModule(query);
  // Batched read helpers — one or a few `IN (...)` / window-function
  // queries that replace the per-item loops the container storefront
  // ran (N+1 over the D1 bridge). Each is ported from the named edge
  // function in worker/data/catalog.js with the SAME SQL shape +
  // output field names, so the dual-rendered HTML stays byte-identical
  // across the edge + container substrates.
  var batch     = _batchModule(query);

  return {
    products:  products,
    variants:  variants,
    prices:    prices,
    inventory: inventory,
    media:     media,
    batch:     batch,
  };
}

// ---- products ------------------------------------------------------------

var PRODUCT_ORDER_KEY = ["updated_at:desc", "id:desc"];

function _productsModule(query, cursorSecret) {
  return {
    create: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("catalog.products.create: input object required");
      _slug(input.slug);
      _title(input.title, "title");
      var description = _description(input.description);
      var status = input.status || "draft";
      _status(status);
      var id = _genId();
      var ts = _now();
      await query(
        "INSERT INTO products (id, slug, title, description, status, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [id, input.slug, input.title, description, status, ts, ts],
      );
      return { id: id, slug: input.slug, title: input.title, description: description, status: status, created_at: ts, updated_at: ts };
    },

    get: async function (id) {
      _id(id, "product id");
      var r = await query("SELECT * FROM products WHERE id = ?1", [id]);
      return r.rows[0] || null;
    },

    bySlug: async function (slug) {
      _slug(slug);
      var r = await query("SELECT * FROM products WHERE slug = ?1", [slug]);
      return r.rows[0] || null;
    },

    list: async function (opts) {
      opts = opts || {};
      var status = opts.status;
      if (status !== undefined) _status(status);
      var limit = opts.limit == null ? 50 : opts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
        throw new TypeError("catalog.products.list: limit must be 1..." + MAX_LIMIT);
      }
      // Tuple cursor (updated_at, id), HMAC-tagged via
      // b.pagination so operators can't forge or replay across
      // orderBy changes. The keyset WHERE is composed manually
      // here because b.pagination.cursor() expects a chainable
      // b.db Query, and we're hitting externalDb via raw SQL.
      var cursorVals = null;
      if (opts.cursor != null) {
        if (typeof opts.cursor !== "string") {
          throw new TypeError("catalog.products.list: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(opts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(PRODUCT_ORDER_KEY)) {
            throw new TypeError("catalog.products.list: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("catalog.products.list: cursor — " + (e && e.message || "malformed"));
        }
      }
      var sql, params;
      if (status !== undefined && cursorVals) {
        sql = "SELECT * FROM products WHERE status = ?1 AND (updated_at < ?2 OR (updated_at = ?2 AND id < ?3)) " +
              "ORDER BY updated_at DESC, id DESC LIMIT ?4";
        params = [status, cursorVals[0], cursorVals[1], limit];
      } else if (status !== undefined) {
        sql = "SELECT * FROM products WHERE status = ?1 ORDER BY updated_at DESC, id DESC LIMIT ?2";
        params = [status, limit];
      } else if (cursorVals) {
        sql = "SELECT * FROM products WHERE updated_at < ?1 OR (updated_at = ?1 AND id < ?2) " +
              "ORDER BY updated_at DESC, id DESC LIMIT ?3";
        params = [cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM products ORDER BY updated_at DESC, id DESC LIMIT ?1";
        params = [limit];
      }
      var r = await query(sql, params);
      var last = r.rows[r.rows.length - 1];
      var next = null;
      if (last && r.rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: PRODUCT_ORDER_KEY,
          vals:     [last.updated_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: r.rows, next_cursor: next };
    },

    update: async function (id, patch) {
      _id(id, "product id");
      if (!patch || typeof patch !== "object") throw new TypeError("catalog.products.update: patch object required");
      var sets = [];
      var params = [];
      var i = 1;
      function _addSet(col, val) {
        // Defense in depth: even though the column name is a hard-
        // coded literal here, route it through safeSql.assertOneOf
        // so a future refactor that introduces dynamic column names
        // can't widen the attack surface to identifier injection.
        b.safeSql.assertOneOf(col, ALLOWED_PRODUCT_COLUMNS);
        sets.push(b.safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (i++));
        params.push(val);
      }
      if (patch.slug !== undefined)        { _slug(patch.slug);            _addSet("slug",        patch.slug); }
      if (patch.title !== undefined)       { _title(patch.title, "title"); _addSet("title",       patch.title); }
      if (patch.description !== undefined) { _addSet("description", _description(patch.description)); }
      if (patch.status !== undefined)      { _status(patch.status);        _addSet("status",      patch.status); }
      if (sets.length === 0) {
        // No-op update — callers shouldn't rely on a heartbeat
        // updated_at flip from an empty patch; throw so the caller
        // is explicit about intent.
        throw new TypeError("catalog.products.update: patch contained no updatable fields");
      }
      var ts = _now();
      sets.push("updated_at = ?" + (i++));
      params.push(ts);
      params.push(id);
      var r = await query("UPDATE products SET " + sets.join(", ") + " WHERE id = ?" + i, params);
      if (r.rowCount === 0) return null;
      return await this.get(id);
    },

    archive: function (id) { return this.update(id, { status: "archived" }); },
    restore: function (id) { return this.update(id, { status: "draft" }); },

    // Title + description substring match against operator- or
    // customer-supplied free text. v1 uses SQLite `LIKE` with the
    // term lowercased on both sides (case-insensitive without
    // depending on the SQLite `NOCASE` collation, which only ASCII-
    // folds and behaves differently across compile-time flags).
    //
    // FTS5 / trigram indexes / synonyms / typo-tolerance land in
    // a follow-up release once an operator surfaces real-corpus
    // ranking demand. The LIKE path is the v1-defensible minimum
    // for a "search a few hundred products" catalog.
    //
    // The user-supplied `q` is escaped against LIKE metacharacters
    // (`%`, `_`, `\`) using a `\` escape clause so a search for
    // `100%` matches only the literal `100%` substring instead of
    // matching every row. Empty / whitespace-only `q` returns
    // `{rows:[], next_cursor:null}` — the route handler renders an
    // empty-results page rather than throwing.
    search: async function (opts) {
      opts = opts || {};
      if (typeof opts.q !== "string") {
        throw new TypeError("catalog.products.search: q must be a string");
      }
      if (opts.q.length > MAX_SEARCH_Q_LEN) {
        throw new TypeError("catalog.products.search: q must be ≤ " + MAX_SEARCH_Q_LEN + " chars");
      }
      var status = opts.status;
      if (status !== undefined) _status(status);
      var limit = opts.limit == null ? 50 : opts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
        throw new TypeError("catalog.products.search: limit must be 1..." + MAX_LIMIT);
      }
      var qTrim = opts.q.trim();
      if (qTrim.length === 0) {
        return { rows: [], next_cursor: null };
      }
      // Neutralize LIKE metacharacters so a search containing `%`
      // or `_` matches only the literal character (otherwise `100%`
      // would match every row). The shared `_likePattern` lowercases
      // and escapes `\` first so the wildcard neutralisation can't be
      // re-escaped — the same helper `batch.searchDecorate` composes.
      var pattern = _likePattern(qTrim);
      var cursorVals = null;
      if (opts.cursor != null) {
        if (typeof opts.cursor !== "string") {
          throw new TypeError("catalog.products.search: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(opts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(PRODUCT_ORDER_KEY)) {
            throw new TypeError("catalog.products.search: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("catalog.products.search: cursor — " + (e && e.message || "malformed"));
        }
      }
      // The `lower(title)` / `lower(description)` calls are SQLite
      // built-ins applied at the column-side. The escape character
      // is declared per statement via the ESCAPE clause; SQLite
      // honours it for both `%` and `_` matches.
      //
      // Build sql + params in a single pass; positional placeholder
      // numbering is driven by an index counter so the cursor-vs-
      // no-cursor / status-vs-no-status combinations stay readable.
      var idx = 1;
      var params = [];
      function _ph(val) { params.push(val); return "?" + (idx++); }
      var clauses = [];
      clauses.push(
        "(lower(title) LIKE " + _ph(pattern) + " ESCAPE '\\' " +
        "OR lower(description) LIKE " + _ph(pattern) + " ESCAPE '\\')"
      );
      if (status !== undefined) {
        clauses.push("status = " + _ph(status));
      }
      if (cursorVals) {
        var pUpdated  = _ph(cursorVals[0]);
        var pUpdated2 = _ph(cursorVals[0]);
        var pId       = _ph(cursorVals[1]);
        clauses.push("(updated_at < " + pUpdated + " OR (updated_at = " + pUpdated2 + " AND id < " + pId + "))");
      }
      var pLimit = _ph(limit);
      var sql = "SELECT * FROM products WHERE " + clauses.join(" AND ") +
        " ORDER BY updated_at DESC, id DESC LIMIT " + pLimit;
      var r = await query(sql, params);
      var last = r.rows[r.rows.length - 1];
      var next = null;
      if (last && r.rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: PRODUCT_ORDER_KEY,
          vals:     [last.updated_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: r.rows, next_cursor: next };
    },
  };
}

// ---- variants ------------------------------------------------------------

function _variantsModule(query) {
  return {
    create: async function (productId, input) {
      _id(productId, "product_id");
      if (!input || typeof input !== "object") throw new TypeError("catalog.variants.create: input object required");
      _sku(input.sku);
      var title = input.title == null ? "" : (function () {
        if (typeof input.title !== "string" || input.title.length > MAX_TITLE_LEN) {
          throw new TypeError("catalog.variants.create: title must be a string ≤ " + MAX_TITLE_LEN + " chars");
        }
        return input.title;
      })();
      var optsJson = _options(input.options);
      var weight = input.weight_grams == null ? 0 : input.weight_grams;
      _nonNegInt(weight, "weight_grams");
      var requiresShipping = input.requires_shipping == null ? 1 : _bool(input.requires_shipping, "requires_shipping");
      var position = input.position == null ? 0 : input.position;
      _nonNegInt(position, "position");
      var id = _genId();
      var ts = _now();
      await query(
        "INSERT INTO variants (id, product_id, sku, title, options_json, weight_grams, requires_shipping, position, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        [id, productId, input.sku, title, optsJson, weight, requiresShipping, position, ts, ts],
      );
      return await this.get(id);
    },

    get: async function (id) {
      _id(id, "variant id");
      var r = await query("SELECT * FROM variants WHERE id = ?1", [id]);
      var row = r.rows[0] || null;
      if (row) row.options = JSON.parse(row.options_json);
      return row;
    },

    bySku: async function (sku) {
      _sku(sku);
      var r = await query("SELECT * FROM variants WHERE sku = ?1", [sku]);
      var row = r.rows[0] || null;
      if (row) row.options = JSON.parse(row.options_json);
      return row;
    },

    listForProduct: async function (productId) {
      _id(productId, "product_id");
      var r = await query("SELECT * FROM variants WHERE product_id = ?1 ORDER BY position ASC, created_at ASC", [productId]);
      return r.rows.map(function (row) { row.options = JSON.parse(row.options_json); return row; });
    },

    update: async function (id, patch) {
      _id(id, "variant id");
      if (!patch || typeof patch !== "object") throw new TypeError("catalog.variants.update: patch object required");
      var sets = [];
      var params = [];
      var i = 1;
      function _addSet(col, val) {
        b.safeSql.assertOneOf(col, ALLOWED_VARIANT_COLUMNS);
        sets.push(b.safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (i++));
        params.push(val);
      }
      if (patch.sku !== undefined)               { _sku(patch.sku);                                _addSet("sku",            patch.sku); }
      if (patch.title !== undefined) {
        if (typeof patch.title !== "string" || patch.title.length > MAX_TITLE_LEN) throw new TypeError("catalog.variants.update: title invalid");
        _addSet("title", patch.title);
      }
      if (patch.options !== undefined)           {                                                  _addSet("options_json",   _options(patch.options)); }
      if (patch.weight_grams !== undefined)      { _nonNegInt(patch.weight_grams, "weight_grams"); _addSet("weight_grams",   patch.weight_grams); }
      if (patch.requires_shipping !== undefined) {                                                  _addSet("requires_shipping", _bool(patch.requires_shipping, "requires_shipping")); }
      if (patch.position !== undefined)          { _nonNegInt(patch.position, "position");          _addSet("position",       patch.position); }
      if (sets.length === 0) throw new TypeError("catalog.variants.update: patch contained no updatable fields");
      var ts = _now();
      sets.push("updated_at = ?" + (i++));
      params.push(ts);
      params.push(id);
      var r = await query("UPDATE variants SET " + sets.join(", ") + " WHERE id = ?" + i, params);
      if (r.rowCount === 0) return null;
      return await this.get(id);
    },

    delete: async function (id) {
      _id(id, "variant id");
      var r = await query("DELETE FROM variants WHERE id = ?1", [id]);
      return r.rowCount > 0;
    },
  };
}

// ---- prices --------------------------------------------------------------

function _pricesModule(query) {
  return {
    // Versioned set — closes the current active price for this
    // (variant, currency) tuple by setting its effective_until, then
    // inserts the new row. Callers see "the price has changed" as a
    // single atomic-ish operation. For D1 (no transactions across
    // HTTP boundary), we do close-then-insert; a concurrent reader
    // that lands between can still get a consistent answer because
    // `current()` filters on `effective_until IS NULL`.
    set: async function (variantId, input) {
      _id(variantId, "variant_id");
      if (!input || typeof input !== "object") throw new TypeError("catalog.prices.set: input object required");
      _currency(input.currency);
      _nonNegInt(input.amount_minor, "amount_minor");
      var ts = _now();
      // 1. Close the prior active price (no-op if none).
      await query(
        "UPDATE prices SET effective_until = ?1 WHERE variant_id = ?2 AND currency = ?3 AND effective_until IS NULL",
        [ts, variantId, input.currency],
      );
      // 2. Insert the new row.
      var id = _genId();
      await query(
        "INSERT INTO prices (id, variant_id, currency, amount_minor, effective_from, effective_until, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)",
        [id, variantId, input.currency, input.amount_minor, ts, ts],
      );
      return { id: id, variant_id: variantId, currency: input.currency, amount_minor: input.amount_minor, effective_from: ts, effective_until: null, created_at: ts };
    },

    current: async function (variantId, currency) {
      _id(variantId, "variant_id");
      _currency(currency);
      var r = await query(
        "SELECT * FROM prices WHERE variant_id = ?1 AND currency = ?2 AND effective_until IS NULL LIMIT 1",
        [variantId, currency],
      );
      return r.rows[0] || null;
    },

    history: async function (variantId, currency) {
      _id(variantId, "variant_id");
      _currency(currency);
      var r = await query(
        "SELECT * FROM prices WHERE variant_id = ?1 AND currency = ?2 ORDER BY effective_from DESC",
        [variantId, currency],
      );
      return r.rows;
    },

    // The distinct currencies this variant has ever been priced in, so a
    // caller (the admin price manager) can render current + history per
    // currency without first knowing which currencies exist. Ordered for a
    // stable display.
    currencies: async function (variantId) {
      _id(variantId, "variant_id");
      var r = await query(
        "SELECT DISTINCT currency FROM prices WHERE variant_id = ?1 ORDER BY currency ASC",
        [variantId],
      );
      return r.rows.map(function (row) { return row.currency; });
    },
  };
}

// ---- inventory -----------------------------------------------------------

function _inventoryModule(query, opts) {
  opts = opts || {};
  // Optional callback invoked after every stock-mutating op so the
  // alerts primitive can decide whether to fire a low-stock alert.
  // Signature: `onStockChange(sku)`. Drop-silent on throw — the
  // observer must never break the stock op that triggered it.
  var onStockChange = typeof opts.onStockChange === "function" ? opts.onStockChange : null;
  async function _afterMutation(sku) {
    if (!onStockChange) return;
    try { await onStockChange(sku); }
    catch (_e) { /* drop-silent — alert-side failure must not roll back the stock op */ }
  }

  return {
    create: async function (sku, input) {
      _sku(sku);
      if (!input || typeof input !== "object") throw new TypeError("catalog.inventory.create: input object required");
      var stock = input.stock_on_hand == null ? 0 : input.stock_on_hand;
      _nonNegInt(stock, "stock_on_hand");
      var ts = _now();
      await query(
        "INSERT INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES (?1, ?2, 0, ?3)",
        [sku, stock, ts],
      );
      return { sku: sku, stock_on_hand: stock, stock_held: 0, updated_at: ts };
    },

    get: async function (sku) {
      _sku(sku);
      var r = await query("SELECT * FROM inventory WHERE sku = ?1", [sku]);
      return r.rows[0] || null;
    },

    // Operator-facing inventory list (sku ASC), optionally only the SKUs at
    // or below their configured low-stock threshold. Capped + uncursored —
    // it backs the admin inventory console, not a hot path.
    list: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? 200 : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
        throw new TypeError("catalog.inventory.list: limit must be 1..1000");
      }
      var sql = listOpts.low_only
        ? "SELECT * FROM inventory WHERE low_stock_threshold IS NOT NULL AND " +
          "(stock_on_hand - stock_held) <= low_stock_threshold ORDER BY sku ASC LIMIT ?1"
        : "SELECT * FROM inventory ORDER BY sku ASC LIMIT ?1";
      return { rows: (await query(sql, [limit])).rows };
    },

    // `hold`, `decrement`, and `release` are the checkout-time stock
    // primitives; `restock` and `setThreshold` are admin operations.
    // Concurrency on the buy path is enforced by the conditional-UPDATE
    // guards in `hold` / `decrement` (the WHERE clause refuses the write
    // when stock is insufficient), so two racing confirms against the
    // same SKU can never both succeed beyond the shelf. The container
    // runs a single replica today; the guards are written to hold under
    // N replicas without change — D1 applies each UPDATE atomically and
    // the WHERE clause re-reads the row inside the same statement, so the
    // check-and-set is a single SQL operation, not a read-then-write race.
    restock: async function (sku, qty) {
      _sku(sku);
      _positiveInt(qty, "qty");
      var ts = _now();
      var r = await query(
        "UPDATE inventory SET stock_on_hand = stock_on_hand + ?1, updated_at = ?2 WHERE sku = ?3",
        [qty, ts, sku],
      );
      if (r.rowCount === 0) return null;
      // Restock raises available; a prior alert state may now clear.
      // The alerts primitive's check() returns alert:false when above
      // threshold, so the callback is safe to fire on every mutation.
      await _afterMutation(sku);
      return await this.get(sku);
    },

    release: async function (sku, qty) {
      _sku(sku);
      _positiveInt(qty, "qty");
      var ts = _now();
      var r = await query(
        "UPDATE inventory SET stock_held = MAX(0, stock_held - ?1), updated_at = ?2 WHERE sku = ?3",
        [qty, ts, sku],
      );
      if (r.rowCount === 0) return null;
      // Release lowers stock_held → raises available. Fire the
      // observer; the alert primitive decides whether to alert.
      await _afterMutation(sku);
      return await this.get(sku);
    },

    // Place an atomic hold against available stock (on_hand − held).
    // Called at checkout-confirm time, BEFORE the buyer is charged, so
    // two concurrent confirms for the last unit can't both proceed. The
    // conditional WHERE is the serialization point: D1 evaluates the
    // `(stock_on_hand - stock_held) >= qty` predicate and applies the
    // `stock_held = stock_held + qty` write in one atomic statement, so
    // the second racer's predicate sees the first racer's increment and
    // the UPDATE matches zero rows.
    //
    // Returns `{ held: true, sku, qty }` when the hold lands;
    // `{ held: false, sku, qty }` when there's a row but it lacks the
    // available stock (the caller renders the friendly out-of-stock
    // message); `null` when the SKU has NO inventory row at all — an
    // un-tracked SKU is treated as unlimited everywhere in the storefront
    // (PDP, facets, edge all read a missing row as available), so a hold
    // simply doesn't apply and the caller lets the line through.
    hold: async function (sku, qty) {
      _sku(sku);
      _positiveInt(qty, "qty");
      var ts = _now();
      var r = await query(
        "UPDATE inventory SET stock_held = stock_held + ?1, updated_at = ?2 " +
        "WHERE sku = ?3 AND (stock_on_hand - stock_held) >= ?1",
        [qty, ts, sku],
      );
      if (r.rowCount === 1) {
        // Hold lowers available; a low-stock threshold may now trip.
        await _afterMutation(sku);
        return { held: true, sku: sku, qty: qty };
      }
      // Zero rows: either the SKU has no row, or it has a row but
      // insufficient available stock. Distinguish so the caller can let
      // an un-tracked SKU through while refusing a tracked-but-empty one.
      var existing = await this.get(sku);
      if (!existing) return null;
      return { held: false, sku: sku, qty: qty };
    },

    // Convert a hold into a sale: debit on_hand and clear the matching
    // held units in one atomic statement. Called on the order's paid
    // transition. The `stock_held >= qty AND stock_on_hand >= qty` guard
    // makes this a no-op for any SKU that was never held (an exempt or
    // un-tracked line) and for a re-delivered paid event whose hold was
    // already consumed — so it is idempotent: a second call against an
    // already-debited SKU matches zero rows and returns `{ decremented:
    // false }`. Both columns stay non-negative (the schema CHECKs would
    // reject otherwise), so a bookkeeping drift can never write a
    // negative shelf.
    decrement: async function (sku, qty) {
      _sku(sku);
      _positiveInt(qty, "qty");
      var ts = _now();
      var r = await query(
        "UPDATE inventory SET stock_on_hand = stock_on_hand - ?1, " +
        "stock_held = stock_held - ?1, updated_at = ?2 " +
        "WHERE sku = ?3 AND stock_held >= ?1 AND stock_on_hand >= ?1",
        [qty, ts, sku],
      );
      if (r.rowCount === 1) {
        await _afterMutation(sku);
        return { decremented: true, sku: sku, qty: qty };
      }
      return { decremented: false, sku: sku, qty: qty };
    },

    // Set / clear the per-SKU low-stock threshold. `threshold = null`
    // disables alerts for the SKU. Operators set this via the admin
    // API (`PATCH /admin/inventory/:sku/threshold`).
    setThreshold: async function (sku, threshold) {
      _sku(sku);
      if (threshold !== null && (!Number.isInteger(threshold) || threshold < 0)) {
        throw new TypeError("catalog.inventory.setThreshold: threshold must be a non-negative integer or null");
      }
      var ts = _now();
      var r = await query(
        "UPDATE inventory SET low_stock_threshold = ?1, updated_at = ?2 WHERE sku = ?3",
        [threshold, ts, sku],
      );
      if (r.rowCount === 0) return null;
      return await this.get(sku);
    },

    // Pure read — returns the current alert state for the SKU.
    //   { alert: bool, available: int|null, threshold: int|null }
    // `alert` is `true` when a threshold is configured and the
    // available stock is strictly below it. A SKU without a
    // threshold (or an unknown SKU) returns `alert: false`.
    checkLowStock: async function (sku) {
      _sku(sku);
      var r = await query(
        "SELECT stock_on_hand, stock_held, low_stock_threshold FROM inventory WHERE sku = ?1",
        [sku],
      );
      var row = r.rows[0];
      if (!row) return { alert: false, available: null, threshold: null };
      var available = row.stock_on_hand - row.stock_held;
      if (row.low_stock_threshold == null) {
        return { alert: false, available: available, threshold: null };
      }
      return {
        alert:     available < row.low_stock_threshold,
        available: available,
        threshold: row.low_stock_threshold,
      };
    },
  };
}

// ---- media ---------------------------------------------------------------

function _mediaModule(query) {
  return {
    attach: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("catalog.media.attach: input object required");
      var pid = input.product_id == null ? null : input.product_id;
      var vid = input.variant_id == null ? null : input.variant_id;
      if (!pid && !vid) throw new TypeError("catalog.media.attach: one of product_id / variant_id required");
      if (pid) _id(pid, "product_id");
      if (vid) _id(vid, "variant_id");
      _r2Key(input.r2_key);
      _contentType(input.content_type);
      var width   = input.width   == null ? 0 : input.width;
      var height  = input.height  == null ? 0 : input.height;
      var position = input.position == null ? 0 : input.position;
      _nonNegInt(width,   "width");
      _nonNegInt(height,  "height");
      _nonNegInt(position, "position");
      var altText = _altText(input.alt_text);
      var id = _genId();
      var ts = _now();
      await query(
        "INSERT INTO media (id, product_id, variant_id, r2_key, content_type, width, height, position, alt_text, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        [id, pid, vid, input.r2_key, input.content_type, width, height, position, altText, ts],
      );
      return { id: id, product_id: pid, variant_id: vid, r2_key: input.r2_key, content_type: input.content_type, width: width, height: height, position: position, alt_text: altText, created_at: ts };
    },

    get: async function (id) {
      _id(id, "media id");
      var r = await query("SELECT * FROM media WHERE id = ?1", [id]);
      return r.rows[0] || null;
    },

    listForProduct: async function (productId) {
      _id(productId, "product_id");
      var r = await query("SELECT * FROM media WHERE product_id = ?1 ORDER BY position ASC, created_at ASC", [productId]);
      return r.rows;
    },

    listForVariant: async function (variantId) {
      _id(variantId, "variant_id");
      var r = await query("SELECT * FROM media WHERE variant_id = ?1 ORDER BY position ASC, created_at ASC", [variantId]);
      return r.rows;
    },

    delete: async function (id) {
      _id(id, "media id");
      var r = await query("DELETE FROM media WHERE id = ?1", [id]);
      return r.rowCount > 0;
    },

    // Reorder a product's media. `orderedIds` is the FULL set of this
    // product's media ids in the desired order; `position` is rewritten to
    // 0..N-1 to match. Throws TypeError on a non-array / id-shape error or
    // when the set doesn't exactly match the product's current media (a
    // missing / extra / foreign id) — a partial reorder would silently drop
    // a row's ordering. D1 has no cross-statement transaction over the HTTP
    // bridge, so positions are written one UPDATE per row, each scoped by
    // product_id so a crafted id list can never reposition another product's
    // row out of band. Returns the count written.
    reorder: async function (productId, orderedIds) {
      _id(productId, "product_id");
      if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
        throw new TypeError("catalog.media.reorder: orderedIds must be a non-empty array");
      }
      orderedIds.forEach(function (id) { _id(id, "media id"); });
      var existing = await query("SELECT id FROM media WHERE product_id = ?1", [productId]);
      var have = existing.rows.map(function (r) { return r.id; }).sort();
      var want = orderedIds.slice().sort();
      if (have.length !== want.length ||
          have.some(function (id, i) { return id !== want[i]; })) {
        throw new TypeError("catalog.media.reorder: orderedIds must list exactly this product's current media");
      }
      for (var i = 0; i < orderedIds.length; i += 1) {
        await query(
          "UPDATE media SET position = ?1 WHERE id = ?2 AND product_id = ?3",
          [i, orderedIds[i], productId],
        );
      }
      return orderedIds.length;
    },

    // Promote one media row to the hero slot (position 0) and push every
    // other row of the same product down by one, preserving their relative
    // order. The PDP gallery renders media[0] as the hero, so this is the
    // "set primary image" operation. Throws TypeError on a malformed id;
    // returns false when the id doesn't resolve to a product-scoped row
    // (an unknown id, or a variant-only row that has no product_id). Every
    // UPDATE is scoped by product_id — same cross-product-IDOR guard as
    // reorder.
    setPrimary: async function (mediaId) {
      _id(mediaId, "media id");
      var row = (await query("SELECT id, product_id FROM media WHERE id = ?1", [mediaId])).rows[0];
      if (!row || !row.product_id) return false;
      var ordered = (await query(
        "SELECT id FROM media WHERE product_id = ?1 ORDER BY position ASC, created_at ASC",
        [row.product_id],
      )).rows.map(function (r) { return r.id; });
      var without = ordered.filter(function (id) { return id !== mediaId; });
      var next = [mediaId].concat(without);
      for (var i = 0; i < next.length; i += 1) {
        await query(
          "UPDATE media SET position = ?1 WHERE id = ?2 AND product_id = ?3",
          [i, next[i], row.product_id],
        );
      }
      return true;
    },
  };
}

// ---- batch (N+1-collapsing read helpers) ---------------------------------
//
// These mirror worker/data/catalog.js — the edge worker already
// produces, in one or a few `IN (...)` / window-function queries, what
// the container storefront re-derived with per-item loops (each a
// full D1-bridge hop). Porting the edge SQL verbatim keeps the two
// substrates in lockstep: the field names + row shapes below are the
// ones the storefront renderers already accept, so the rendered HTML /
// JSON-LD is unchanged.
//
// Every helper composes the module's `query(sql, params)` closure +
// the existing validators. Each is missing-table-resilient (catch
// `/no such table/i` → empty) to match the edge + the never-500-the-
// page stance, EXCEPT entry-point validation (a malformed id throws
// TypeError, which the route catches → 404/empty). The IN(...) lists
// use positional placeholders generated from array length, values
// bound positionally — never interpolated.

// First-variant / first-media decorated SELECT — ported verbatim from
// the edge `DECORATED_SELECT` (worker/data/catalog.js). Window
// functions pick the first variant (position ASC, created_at ASC) +
// first media per product in one round trip; the price is joined off
// the hero variant for the requested currency. `?1` is the currency.
var _DECORATED_SELECT =
  "SELECT p.*, " +
  "       v.id        AS hero_variant_id, " +
  "       pr.amount_minor AS starting_price_minor, " +
  "       pr.currency     AS starting_price_currency, " +
  "       m.r2_key    AS hero_r2_key, " +
  "       m.alt_text  AS hero_alt_text " +
  "FROM products p " +
  "LEFT JOIN ( " +
  "  SELECT iv.*, " +
  "         ROW_NUMBER() OVER (PARTITION BY iv.product_id ORDER BY iv.position ASC, iv.created_at ASC) AS rn " +
  "  FROM variants iv " +
  ") v ON v.product_id = p.id AND v.rn = 1 " +
  "LEFT JOIN prices pr ON pr.variant_id = v.id AND pr.currency = ?1 AND pr.effective_until IS NULL " +
  "LEFT JOIN ( " +
  "  SELECT im.*, " +
  "         ROW_NUMBER() OVER (PARTITION BY im.product_id ORDER BY im.position ASC, im.created_at ASC) AS rn " +
  "  FROM media im " +
  "  WHERE im.product_id IS NOT NULL " +
  ") m ON m.product_id = p.id AND m.rn = 1 ";

// Shape a decorated row to the exact output `_shapeDecoratedRow`
// produces at the edge (worker/data/catalog.js): the product columns
// plus `starting_price_minor` / `starting_price_currency` /
// `hero_media`. No arithmetic — `starting_price_minor` is the raw
// integer minor-unit amount passed through.
function _shapeDecoratedRow(r) {
  var hero = (r.hero_r2_key != null)
    ? { r2_key: r.hero_r2_key, alt_text: r.hero_alt_text || "" }
    : null;
  return {
    id:                      r.id,
    slug:                    r.slug,
    title:                   r.title,
    description:             r.description,
    status:                  r.status,
    created_at:              r.created_at,
    updated_at:              r.updated_at,
    starting_price_minor:    r.starting_price_minor != null ? r.starting_price_minor : null,
    starting_price_currency: r.starting_price_currency || "USD",
    hero_media:              hero,
  };
}

function _batchModule(query) {
  // Default to USD when an unset / wrong-shape currency reaches a
  // helper, matching the edge's `(len === 3) ? cur : "USD"` guard.
  function _ccy(c) {
    return (typeof c === "string" && c.length === 3) ? c : "USD";
  }

  return {
    // Decorate a set of product ids in one query (backs PERF-5 home
    // grid + PERF-1 related). Returns `{ rows, byId }`: `rows` carries
    // one decorated row per matching id in `created_at`-stable order
    // and `byId` maps id → row so the caller can re-impose its own
    // order. Mirrors the edge `DECORATED_SELECT` + `_shapeDecoratedRow`.
    decoratedProducts: async function (productIds, currency) {
      if (!Array.isArray(productIds) || productIds.length === 0) return { rows: [], byId: {} };
      var ids = productIds.map(function (id) { return _id(id, "product id"); });
      var cur = _ccy(currency);
      var placeholders = ids.map(function (_v, n) { return "?" + (n + 2); }).join(", ");
      var params = [cur].concat(ids);
      var r = await query(
        _DECORATED_SELECT +
        "WHERE p.id IN (" + placeholders + ") " +
        "ORDER BY p.created_at ASC, p.id ASC",
        params,
      );
      var rows = [];
      var byId = {};
      for (var i = 0; i < r.rows.length; i += 1) {
        var shaped = _shapeDecoratedRow(r.rows[i]);
        rows.push(shaped);
        byId[shaped.id] = shaped;
      }
      return { rows: rows, byId: byId };
    },

    // Active products decorated in one query (backs PERF-5 / UX-8 home
    // grid). Mirrors the edge `listActiveProducts`: status='active',
    // ORDER BY updated_at DESC, id DESC, LIMIT/OFFSET. Returns
    // `{ rows }`.
    decoratedActive: async function (opts) {
      opts = opts || {};
      var cur = _ccy(opts.currency);
      var limit  = opts.limit  == null ? 24 : opts.limit;
      var offset = opts.offset == null ? 0  : opts.offset;
      _positiveInt(limit, "limit");
      _nonNegInt(offset, "offset");
      var r = await query(
        _DECORATED_SELECT +
        "WHERE p.status = 'active' " +
        "ORDER BY p.updated_at DESC, p.id DESC " +
        "LIMIT ?2 OFFSET ?3",
        [cur, limit, offset],
      );
      var rows = [];
      for (var i = 0; i < r.rows.length; i += 1) rows.push(_shapeDecoratedRow(r.rows[i]));
      return { rows: rows };
    },

    // Variants + their current price for a product in one query (backs
    // PERF-3 PDP). Mirrors the edge `listVariantsWithPrices`: LEFT JOIN
    // the active price (effective_until IS NULL) for `currency`,
    // ordered position ASC, created_at ASC. Returns `{ rows, prices }`:
    //   - `rows`   — the variant rows shaped like `variants.listForProduct`
    //                (options_json parsed to `options`), price columns dropped
    //                so the shape is byte-identical to the per-item path.
    //   - `prices` — { variantId: priceRow } for variants that HAVE a
    //                price in `currency`, each priceRow shaped like
    //                `prices.current` output.
    variantsWithPrices: async function (productId, currency) {
      _id(productId, "product_id");
      var cur = _ccy(currency);
      var r = await query(
        "SELECT v.*, " +
        "       pr.id              AS price_id, " +
        "       pr.amount_minor    AS price_amount_minor, " +
        "       pr.currency        AS price_currency, " +
        "       pr.effective_from  AS price_effective_from, " +
        "       pr.effective_until AS price_effective_until, " +
        "       pr.created_at      AS price_created_at " +
        "FROM variants v " +
        "LEFT JOIN prices pr ON pr.variant_id = v.id AND pr.currency = ?1 AND pr.effective_until IS NULL " +
        "WHERE v.product_id = ?2 " +
        "ORDER BY v.position ASC, v.created_at ASC",
        [cur, productId],
      );
      var rows = [];
      var prices = {};
      for (var i = 0; i < r.rows.length; i += 1) {
        var raw = r.rows[i];
        // Lift the joined price into the per-variant prices map, shaped
        // exactly like `prices.current` output (only when a price for
        // `currency` exists), then strip the joined price columns off
        // the variant row so the row shape is byte-identical to
        // `variants.listForProduct` (the variant columns + parsed
        // `options`). Deleting the extra keys in place preserves the
        // row's identity/prototype so the two paths deep-equal.
        if (raw.price_amount_minor != null) {
          prices[raw.id] = {
            id:              raw.price_id,
            variant_id:      raw.id,
            currency:        raw.price_currency,
            amount_minor:    raw.price_amount_minor,
            effective_from:  raw.price_effective_from,
            effective_until: raw.price_effective_until,
            created_at:      raw.price_created_at,
          };
        }
        delete raw.price_id;
        delete raw.price_amount_minor;
        delete raw.price_currency;
        delete raw.price_effective_from;
        delete raw.price_effective_until;
        delete raw.price_created_at;
        raw.options = JSON.parse(raw.options_json);
        rows.push(raw);
      }
      return { rows: rows, prices: prices };
    },

    // Inventory rows for a set of SKUs in one query, keyed by SKU
    // (backs PERF-6 cart-line stock). Mirrors the edge
    // `listInventoryForSkus`: the trimmed `{ stock_on_hand, stock_held }`
    // shape — sufficient for the cart, which derives its low-stock band
    // from an operator config value, not the per-SKU column. A SKU with
    // no inventory row is absent from the map (the renderer treats
    // absence as available). Missing-table-resilient → {}.
    inventoryForSkus: async function (skus) {
      if (!Array.isArray(skus) || skus.length === 0) return {};
      var out = {};
      try {
        var placeholders = skus.map(function (_s, i) { return "?" + (i + 1); }).join(", ");
        var r = await query(
          "SELECT sku, stock_on_hand, stock_held FROM inventory WHERE sku IN (" + placeholders + ")",
          skus,
        );
        for (var i = 0; i < r.rows.length; i += 1) {
          out[r.rows[i].sku] = { stock_on_hand: r.rows[i].stock_on_hand, stock_held: r.rows[i].stock_held };
        }
      } catch (e) {
        if (e && /no such table/i.test(e.message || "")) return {};
        throw e;
      }
      return out;
    },

    // Full inventory rows for a set of SKUs in one query, keyed by SKU
    // (backs PERF-3 PDP availability). Returns the SAME full-row shape
    // `inventory.get` does (`SELECT *` → sku, stock_on_hand, stock_held,
    // low_stock_threshold, updated_at), keeping the PDP's per-SKU
    // inventory map byte-identical to the prior per-variant
    // `inventory.get` loop. The PDP's availability resolver reads
    // `low_stock_threshold` to surface the "Only N left" nudge, so the
    // PDP needs the full row — the trimmed `inventoryForSkus` above is
    // for the cart, which doesn't. A SKU with no inventory row is absent
    // (renderer treats absence as available). Missing-table-resilient
    // → {}.
    inventoryRowsForSkus: async function (skus) {
      if (!Array.isArray(skus) || skus.length === 0) return {};
      var out = {};
      try {
        var placeholders = skus.map(function (_s, i) { return "?" + (i + 1); }).join(", ");
        var r = await query(
          "SELECT * FROM inventory WHERE sku IN (" + placeholders + ")",
          skus,
        );
        for (var i = 0; i < r.rows.length; i += 1) {
          out[r.rows[i].sku] = r.rows[i];
        }
      } catch (e) {
        if (e && /no such table/i.test(e.message || "")) return {};
        throw e;
      }
      return out;
    },

    // The facetable product universe for a set of search terms (backs
    // PERF-2). Ported from the edge `searchFacetableProducts`: one
    // decorated SELECT with an OR-of-LIKE term clause, then a
    // collection_members `IN` (MANUAL membership only — see PD-1) +
    // a grouped-inventory `IN`. Terms are deduped case-insensitively.
    // Returns `{ rows }` where each row is the decorated shape PLUS
    // `collection` (array of slugs), `price_minor` (int|null), and
    // `in_stock` (bool) — the shape the faceting walker + search-card
    // renderer consume. The collection + inventory reads are
    // missing-table-resilient (a partially-migrated deploy degrades to
    // the fields it has rather than 500ing search).
    searchDecorate: async function (opts) {
      opts = opts || {};
      var terms = Array.isArray(opts.terms) ? opts.terms : [];
      var dedup = {};
      var cleaned = [];
      for (var ti = 0; ti < terms.length; ti += 1) {
        var term = typeof terms[ti] === "string" ? terms[ti].trim() : "";
        if (!term.length || dedup[term.toLowerCase()]) continue;
        dedup[term.toLowerCase()] = true;
        cleaned.push(term);
      }
      if (!cleaned.length) return { rows: [] };
      var cur = _ccy(opts.currency);
      // Cap the candidate universe wider than the page so facet counts
      // reflect the full match set. MAX_LIMIT keeps the in-memory facet
      // walk bounded — matches the edge's MAX_LIMIT (100) cap.
      var universeLimit = 100;

      // One OR-of-LIKE clause per term. Positional params: ?1 is the
      // price currency, ?2 the universe limit; term patterns start at ?3.
      var likeClauses = [];
      var params = [cur, universeLimit];
      var ph = 3;
      for (var c = 0; c < cleaned.length; c += 1) {
        var pat = _likePattern(cleaned[c]);
        likeClauses.push("lower(p.title) LIKE ?" + ph + " ESCAPE '\\'");
        params.push(pat);
        ph += 1;
        likeClauses.push("lower(p.description) LIKE ?" + ph + " ESCAPE '\\'");
        params.push(pat);
        ph += 1;
      }
      var r = await query(
        _DECORATED_SELECT +
        "WHERE p.status = 'active' AND (" + likeClauses.join(" OR ") + ") " +
        "ORDER BY p.updated_at DESC, p.id DESC LIMIT ?2",
        params,
      );
      var raw = r.rows;
      if (!raw.length) return { rows: [] };

      var ids = raw.map(function (row) { return row.id; });
      var byId = {};
      var rows = [];
      for (var i = 0; i < raw.length; i += 1) {
        var shaped = _shapeDecoratedRow(raw[i]);
        shaped.collection = [];
        shaped.price_minor = shaped.starting_price_minor != null ? shaped.starting_price_minor : null;
        shaped.in_stock = false;
        byId[shaped.id] = shaped;
        rows.push(shaped);
      }

      var placeholders = ids.map(function (_v, n) { return "?" + (n + 1); }).join(", ");

      // Collection memberships — categorical facet field `collection`.
      // MANUAL membership only (collection_members joined to a live
      // collection), matching the edge. Smart-collection rule matches
      // are intentionally NOT included (PD-1 convergence).
      try {
        var cmRes = await query(
          "SELECT cm.product_id AS pid, cm.collection_slug AS slug " +
          "FROM collection_members cm " +
          "JOIN collections col ON col.slug = cm.collection_slug AND col.archived_at IS NULL " +
          "WHERE cm.product_id IN (" + placeholders + ")",
          ids,
        );
        for (var cm = 0; cm < cmRes.rows.length; cm += 1) {
          var pr1 = byId[cmRes.rows[cm].pid];
          if (pr1 && cmRes.rows[cm].slug) pr1.collection.push(cmRes.rows[cm].slug);
        }
      } catch (e) {
        if (!(e && /no such table/i.test(e.message || ""))) throw e;
      }

      // In-stock — true when any variant SKU has available stock
      // (stock_on_hand > stock_held). Boolean facet field `in_stock`.
      try {
        var invRes = await query(
          "SELECT v.product_id AS pid, " +
          "       MAX(CASE WHEN (inv.stock_on_hand - inv.stock_held) > 0 THEN 1 ELSE 0 END) AS any_stock " +
          "FROM variants v " +
          "JOIN inventory inv ON inv.sku = v.sku " +
          "WHERE v.product_id IN (" + placeholders + ") " +
          "GROUP BY v.product_id",
          ids,
        );
        for (var iv = 0; iv < invRes.rows.length; iv += 1) {
          var pr2 = byId[invRes.rows[iv].pid];
          if (pr2) pr2.in_stock = Number(invRes.rows[iv].any_stock) === 1;
        }
      } catch (e2) {
        if (!(e2 && /no such table/i.test(e2.message || ""))) throw e2;
      }

      return { rows: rows };
    },

    // "You may also like" siblings for a product, decorated in one
    // query (backs PERF-1). Ported from the edge `listRelatedProducts`
    // sibling SELECT: the other active members of `collectionSlug`
    // (self excluded), ordered membership position ASC then product id
    // ASC, capped at `limit`, each carrying its first variant's current
    // price + first media row. Returns the exact
    // `{ slug, title, hero_r2_key, hero_alt_text, price_minor,
    // price_currency }` shape the rail renderer consumes. NOTE: this is
    // ONLY the sibling decoration — the primary-collection lookup stays
    // in the caller (it already has it).
    relatedSiblings: async function (collectionSlug, excludeProductId, currency, limit) {
      _slug(collectionSlug);
      _id(excludeProductId, "product_id");
      var cur = _ccy(currency);
      var n = (Number.isInteger(limit) && limit > 0) ? limit : 4;
      var r = await query(
        "SELECT p.id AS id, p.slug AS slug, p.title AS title, " +
        "       pr.amount_minor AS price_amount_minor, " +
        "       pr.currency     AS price_currency, " +
        "       m.r2_key        AS hero_r2_key, " +
        "       m.alt_text      AS hero_alt_text " +
        "FROM collection_members cm " +
        "JOIN products p ON p.id = cm.product_id " +
        "LEFT JOIN ( " +
        "  SELECT iv.*, " +
        "         ROW_NUMBER() OVER (PARTITION BY iv.product_id ORDER BY iv.position ASC, iv.created_at ASC) AS rn " +
        "  FROM variants iv " +
        ") v ON v.product_id = p.id AND v.rn = 1 " +
        "LEFT JOIN prices pr ON pr.variant_id = v.id AND pr.currency = ?1 AND pr.effective_until IS NULL " +
        "LEFT JOIN ( " +
        "  SELECT im.*, " +
        "         ROW_NUMBER() OVER (PARTITION BY im.product_id ORDER BY im.position ASC, im.created_at ASC) AS rn " +
        "  FROM media im " +
        "  WHERE im.product_id IS NOT NULL " +
        ") m ON m.product_id = p.id AND m.rn = 1 " +
        "WHERE cm.collection_slug = ?2 AND cm.product_id != ?3 AND p.status = 'active' " +
        "ORDER BY cm.position ASC, cm.product_id ASC LIMIT ?4",
        [cur, collectionSlug, excludeProductId, n],
      );
      return r.rows.map(function (row) {
        return {
          slug:           row.slug,
          title:          row.title,
          hero_r2_key:    row.hero_r2_key != null ? row.hero_r2_key : null,
          hero_alt_text:  row.hero_r2_key != null ? (row.hero_alt_text || row.title) : null,
          price_minor:    row.price_amount_minor != null ? row.price_amount_minor : null,
          price_currency: row.price_currency || "USD",
        };
      });
    },

    // Variants for a set of SKUs in one query, keyed by SKU (backs
    // PERF-9 bundle member-title batching). Returns a map sku → variant
    // row shaped like `variants.bySku` output (options_json parsed to
    // `options`). Used to collect every bundle member's owning product
    // id in one hop instead of a per-member `variants.bySku`.
    variantsBySkus: async function (skus) {
      if (!Array.isArray(skus) || skus.length === 0) return {};
      var unique = [];
      var seen = Object.create(null);
      for (var s = 0; s < skus.length; s += 1) {
        var sk = skus[s];
        if (typeof sk !== "string" || seen[sk]) continue;
        seen[sk] = true;
        unique.push(sk);
      }
      if (!unique.length) return {};
      var placeholders = unique.map(function (_v, n) { return "?" + (n + 1); }).join(", ");
      var r = await query(
        "SELECT * FROM variants WHERE sku IN (" + placeholders + ")",
        unique,
      );
      var out = {};
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        row.options = JSON.parse(row.options_json);
        out[row.sku] = row;
      }
      return out;
    },

    // Variants for a set of variant ids in one query, keyed by id
    // (backs PERF-6 cart reprice). Returns a map id → variant row
    // shaped like `variants.get` output (options_json parsed to
    // `options`) — the same value the prior per-line `variants.get`
    // returned, keyed by the stable variant_id the cart line carries.
    variantsByIds: async function (variantIds) {
      if (!Array.isArray(variantIds) || variantIds.length === 0) return {};
      var unique = [];
      var seen = Object.create(null);
      for (var n = 0; n < variantIds.length; n += 1) {
        var vid = variantIds[n];
        if (typeof vid !== "string" || !vid.length || seen[vid]) continue;
        seen[vid] = true;
        unique.push(_id(vid, "variant id"));
      }
      if (!unique.length) return {};
      var placeholders = unique.map(function (_v, i) { return "?" + (i + 1); }).join(", ");
      var r = await query(
        "SELECT * FROM variants WHERE id IN (" + placeholders + ")",
        unique,
      );
      var out = {};
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        row.options = JSON.parse(row.options_json);
        out[row.id] = row;
      }
      return out;
    },

    // Products for a set of ids in one query, keyed by id (backs PERF-9
    // bundle member-title batching). Returns a map id → product row.
    productsByIds: async function (productIds) {
      if (!Array.isArray(productIds) || productIds.length === 0) return {};
      var ids = productIds.map(function (id) { return _id(id, "product id"); });
      var placeholders = ids.map(function (_v, n) { return "?" + (n + 1); }).join(", ");
      var r = await query(
        "SELECT * FROM products WHERE id IN (" + placeholders + ")",
        ids,
      );
      var out = {};
      for (var i = 0; i < r.rows.length; i += 1) out[r.rows[i].id] = r.rows[i];
      return out;
    },

    // Every price row (current + history) for a set of variant ids in
    // one query, grouped into the per-variant price model the admin
    // product-detail screen builds (backs PERF-4). Replaces the admin's
    // triple-nested per-variant → per-currency → (prices.current +
    // prices.history) loop with a single read. Returns a map
    //   { variantId: { currencies: [{ currency, current, history }] } }
    // byte-identical to the per-item build:
    //   - `currencies` is one entry per distinct currency, ordered ASC
    //     (the order `prices.currencies` returns).
    //   - `current` is the open price row (effective_until IS NULL) for
    //     that currency, or null — matching `prices.current`.
    //   - `history` is every row for that currency ordered effective_from
    //     DESC — matching `prices.history`.
    // EVERY input variant id is present in the map; a variant with no
    // prices maps to `{ currencies: [] }` (the per-item path's empty
    // build). Price rows are the raw `SELECT *` shape (no arithmetic —
    // amount_minor is the integer minor-unit value passed through).
    pricesForVariants: async function (variantIds) {
      if (!Array.isArray(variantIds) || variantIds.length === 0) return {};
      var unique = [];
      var seen = Object.create(null);
      for (var n = 0; n < variantIds.length; n += 1) {
        var vid = variantIds[n];
        if (typeof vid !== "string" || !vid.length) continue;
        var canon = _id(vid, "variant id");
        if (seen[canon]) continue;
        seen[canon] = true;
        unique.push(canon);
      }
      var out = {};
      // Seed every requested variant so an unpriced variant still maps to
      // an empty currencies list (the per-item loop's `{ currencies: [] }`).
      for (var s = 0; s < unique.length; s += 1) out[unique[s]] = { currencies: [] };
      if (!unique.length) return out;
      var placeholders = unique.map(function (_v, i) { return "?" + (i + 1); }).join(", ");
      // ORDER BY variant_id, currency ASC (matches prices.currencies'
      // ASC ordering), then effective_from DESC (matches prices.history).
      var r = await query(
        "SELECT * FROM prices WHERE variant_id IN (" + placeholders + ") " +
        "ORDER BY variant_id, currency, effective_from DESC",
        unique,
      );
      // Group variant → currency. The currency-ASC ordering means the
      // first time a (variant, currency) pair is seen drives its position
      // in the `currencies` array, reproducing the per-currency loop order.
      var byVariantCurrency = {};
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var bucket = out[row.variant_id];
        if (!bucket) continue;   // a price for a variant outside the input set
        var key = row.variant_id + "\u0000" + row.currency;
        var entry = byVariantCurrency[key];
        if (!entry) {
          entry = { currency: row.currency, current: null, history: [] };
          byVariantCurrency[key] = entry;
          bucket.currencies.push(entry);
        }
        entry.history.push(row);
        if (row.effective_until == null && entry.current == null) entry.current = row;
      }
      return out;
    },
  };
}

module.exports = {
  create: create,
};
