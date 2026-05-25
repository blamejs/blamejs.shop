"use strict";
/**
 * @module shop.productCompare
 * @title  Product compare — side-by-side comparison basket for the
 *         storefront
 *
 * @intro
 *   The storefront's "compare 2-4 products side-by-side" widget. A
 *   shopper browses a collection page, taps "compare" on each of two
 *   to four products, then navigates to the compare table — the
 *   primitive holds the basket (per-session, capped at four entries)
 *   and renders the per-attribute table the storefront paints.
 *
 *   Four pieces:
 *
 *     1. Per-session compare basket (`addToCompare` /
 *        `removeFromCompare` / `getCompareList` / `clearCompareList`).
 *        The basket is anchored to the namespace-hashed session
 *        cookie; the raw cookie value never lands in the database. A
 *        logged-in shopper's `customer_id` rides alongside so the
 *        account-page widget can resume the basket on a different
 *        device.
 *
 *     2. Per-attribute resolver (`compareTable`). The compare table's
 *        rows are operator-declared attributes; the resolver walks
 *        the basket's product ids, asks the injected `catalog`
 *        handle for each product, pulls the requested attribute's
 *        value from the configured source (variant column / product
 *        column / metadata bag), and shapes the result as
 *        `{ products, rows: [{ attribute, values_per_product }] }`
 *        so the storefront's template renderer paints one cell per
 *        (attribute, product) pair without further joins.
 *
 *     3. Operator-extensible attribute catalog (`defineCompareAttribute`
 *        / `listAttributes`). Seven defaults ship in the primitive
 *        (price / sku / brand / vendor / weight / dimensions /
 *        inventory_status) so a fresh storefront serves a working
 *        compare table without operator setup; custom attributes
 *        (warranty, country_of_origin, certifications, ...) get added
 *        for category-specific compare tables.
 *
 *     4. Impression telemetry (`recordImpression` / `popularCompares`).
 *        Every "product added to compare" event lands in
 *        `compare_impressions` so the merchandising widget can render
 *        "most-compared products this week" without dragging the
 *        per-session basket table into the rollup.
 *
 *   Cap:
 *     The basket caps at four entries. A `addToCompare` call against
 *     a full basket refuses with `error.code = "COMPARE_FULL"` so the
 *     storefront can surface "remove one to add another" without
 *     re-querying.
 *
 *   Session-id privacy:
 *     The session id is `namespaceHash("product-compare-session", raw)`
 *     before persist. A database dump can't be replayed to recover
 *     active baskets, and the cleanup sweep that prunes stale baskets
 *     leaves the impressions row in place so the long-window rollup
 *     keeps its historical depth.
 *
 *   Composes:
 *     - `b.guardUuid` — every product_id / customer_id is strict-UUID-
 *       sanitised at the entry point.
 *     - `b.crypto.namespaceHash` — session-id hashing.
 *     - `b.uuid.v7` — row ids (lexicographic + monotonic so impressions
 *       with the same `occurred_at` still sort deterministically).
 *     - `catalog` (optional, required by `compareTable`) — the table-
 *       rendering verb walks the basket's product ids through
 *       `catalog.getProduct(...)` to resolve each attribute value.
 *       Without a catalog handle, `compareTable` refuses (the other
 *       verbs work standalone — operators can hold a basket without
 *       resolving the table).
 *
 * @primitive productCompare
 * @related   b.guardUuid, b.crypto.namespaceHash, b.uuid, catalog
 */

var b = require("./index").framework;
var C = b.constants;

// ---- constants ----------------------------------------------------------

var MAX_COMPARE          = 4;
var MIN_COMPARE_FOR_TABLE = 1;
var SESSION_NAMESPACE    = "product-compare-session";
var SESSION_ID_RE        = /^[A-Za-z0-9_-]{16,64}$/;
var SLUG_RE              = /^[a-z](?:[a-z0-9_-]*[a-z0-9])?$/;
var MAX_SLUG_LEN         = 64;
var MAX_LABEL_LEN        = 100;
var MAX_LIST_LIMIT       = 200;
var DEFAULT_POPULAR_LIMIT = 20;
var MAX_SOURCE_KIND_LEN  = 48;
var SOURCE_KIND_RE       = /^[a-z](?:[a-z0-9_-]*[a-z0-9])?$/;

var ATTRIBUTE_SOURCES = Object.freeze(["variant", "product", "metadata"]);
var ATTRIBUTE_FORMATS = Object.freeze(["text", "number", "currency", "boolean", "enum"]);

// Seven baked-in defaults so a fresh storefront serves a working
// compare table without operator setup. Each row mirrors a column
// CHECK constraint in compare_attributes (source / format enum).
// Operators override by calling `defineCompareAttribute` with the
// same slug — that upserts the catalog row, after which the default
// is no longer consulted.
var DEFAULT_ATTRIBUTES = Object.freeze([
  Object.freeze({ slug: "price",              label: "Price",              source: "variant",  format: "currency" }),
  Object.freeze({ slug: "sku",                label: "SKU",                source: "variant",  format: "text"     }),
  Object.freeze({ slug: "brand",              label: "Brand",              source: "product",  format: "text"     }),
  Object.freeze({ slug: "vendor",             label: "Vendor",             source: "product",  format: "text"     }),
  Object.freeze({ slug: "weight",             label: "Weight",             source: "variant",  format: "number"   }),
  Object.freeze({ slug: "dimensions",         label: "Dimensions",         source: "metadata", format: "text"     }),
  Object.freeze({ slug: "inventory_status",   label: "Inventory status",   source: "variant",  format: "enum"     }),
]);
var DEFAULT_ATTRIBUTE_SLUGS = Object.freeze(DEFAULT_ATTRIBUTES.map(function (a) { return a.slug; }));

// ---- monotonic clock ---------------------------------------------------
//
// Multiple addToCompare / recordImpression calls inside the same
// millisecond on a fast host would otherwise tie on `updated_at` /
// `occurred_at`, breaking the deterministic order the rollup +
// cleanup sweeps rely on. Bumping by 1ms on a tie keeps the timeline
// strictly increasing.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("product-compare: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _optionalUuid(s, label) {
  if (s == null) return null;
  return _uuid(s, label);
}

function _sessionId(s) {
  if (typeof s !== "string" || !SESSION_ID_RE.test(s)) {
    throw new TypeError("product-compare: session_id must be 16-64 chars of [A-Za-z0-9_-]");
  }
  return s;
}

function _hashSession(s) {
  return b.crypto.namespaceHash(SESSION_NAMESPACE, s);
}

function _slug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("product-compare: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("product-compare: " + label + " must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("product-compare: " + label + " must match /[a-z][a-z0-9_-]*[a-z0-9]/");
  }
  return s;
}

function _label(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_LABEL_LEN) {
    throw new TypeError("product-compare: label must be a non-empty string <= " + MAX_LABEL_LEN + " chars");
  }
  return s;
}

function _source(s) {
  if (ATTRIBUTE_SOURCES.indexOf(s) === -1) {
    throw new TypeError("product-compare: source must be one of " + ATTRIBUTE_SOURCES.join(", "));
  }
  return s;
}

function _format(s) {
  if (ATTRIBUTE_FORMATS.indexOf(s) === -1) {
    throw new TypeError("product-compare: format must be one of " + ATTRIBUTE_FORMATS.join(", "));
  }
  return s;
}

function _sourceKind(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("product-compare: source_kind must be a non-empty string");
  }
  if (s.length > MAX_SOURCE_KIND_LEN) {
    throw new TypeError("product-compare: source_kind must be <= " + MAX_SOURCE_KIND_LEN + " chars");
  }
  if (!SOURCE_KIND_RE.test(s)) {
    throw new TypeError("product-compare: source_kind must match /[a-z][a-z0-9_-]*[a-z0-9]/");
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("product-compare: " + label + " must be a positive integer (epoch ms)");
  }
  return n;
}

function _limit(n, label) {
  if (n == null) return DEFAULT_POPULAR_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("product-compare: " + label + " must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _days(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("product-compare: days must be a non-negative integer");
  }
  return n;
}

// ---- attribute resolver helpers ----------------------------------------
//
// Given a product (as returned by catalog.getProduct(...)) and an
// attribute descriptor, pull the typed value. The shape is
// intentionally permissive — every operator wires `catalog` to their
// own schema, so the resolver walks the obvious paths and returns
// `null` when the value isn't present (rather than throwing). The
// storefront's renderer paints "—" for a null cell.

function _firstVariant(product) {
  if (!product || typeof product !== "object") return null;
  var variants = product.variants;
  if (!Array.isArray(variants) || !variants.length) return null;
  return variants[0];
}

function _readMetadata(product, slug) {
  if (!product || typeof product !== "object") return null;
  var meta = product.metadata_json;
  if (meta == null) meta = product.metadata;
  if (meta && typeof meta === "string") {
    try { meta = JSON.parse(meta); }
    catch (_e) { return null; }
  }
  if (!meta || typeof meta !== "object") return null;
  return Object.prototype.hasOwnProperty.call(meta, slug) ? meta[slug] : null;
}

function _resolveAttributeValue(product, attr) {
  if (product == null) return null;
  if (attr.source === "product") {
    if (!Object.prototype.hasOwnProperty.call(product, attr.slug)) return null;
    var pv = product[attr.slug];
    return pv == null ? null : pv;
  }
  if (attr.source === "variant") {
    var variant = _firstVariant(product);
    if (!variant) return null;
    // Variant pricing maps to a couple of common column shapes —
    // `price`, `price_minor`, `unit_price_minor`. The default `price`
    // attribute reads whichever one the operator's catalog populated.
    if (attr.slug === "price") {
      if (variant.price_minor != null)      return variant.price_minor;
      if (variant.unit_price_minor != null) return variant.unit_price_minor;
      if (variant.price != null)            return variant.price;
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(variant, attr.slug)) return null;
    var vv = variant[attr.slug];
    return vv == null ? null : vv;
  }
  // metadata
  return _readMetadata(product, attr.slug);
}

// ---- row hydration ------------------------------------------------------

function _hydrateList(row) {
  if (!row) return null;
  var ids;
  try { ids = JSON.parse(row.product_ids_json || "[]"); }
  catch (_e) { ids = []; }
  return {
    id:               row.id,
    session_id_hash:  row.session_id_hash,
    customer_id:      row.customer_id == null ? null : row.customer_id,
    product_ids:      Array.isArray(ids) ? ids : [],
    created_at:       Number(row.created_at),
    updated_at:       Number(row.updated_at),
  };
}

function _hydrateAttribute(row) {
  if (!row) return null;
  return {
    slug:         row.slug,
    label:        row.label,
    source:       row.source,
    format:       row.format,
    archived_at:  row.archived_at == null ? null : Number(row.archived_at),
    created_at:   Number(row.created_at),
    updated_at:   Number(row.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // catalog is optional — required only by `compareTable`. Holding /
  // mutating the basket without resolving the table works standalone
  // so the storefront's add-to-compare tap doesn't have to wait for
  // the catalog handle to be wired.
  var catalog = opts.catalog || null;
  if (catalog && typeof catalog.getProduct !== "function") {
    throw new TypeError("product-compare.create: opts.catalog must expose a getProduct(product_id) method");
  }

  async function _getListByHash(sessionHash) {
    var r = await query("SELECT * FROM compare_lists WHERE session_id_hash = ?1", [sessionHash]);
    return r.rows.length ? r.rows[0] : null;
  }

  async function _getAttributeBySlug(slug) {
    var r = await query("SELECT * FROM compare_attributes WHERE slug = ?1", [slug]);
    return r.rows.length ? r.rows[0] : null;
  }

  // Resolve an attribute descriptor by slug — operator-defined rows
  // take precedence over the baked-in defaults so an operator can
  // re-shape a default (point `price` at a different metadata key,
  // for instance) without breaking historical compare-table reads.
  async function _resolveAttribute(slug) {
    var row = await _getAttributeBySlug(slug);
    if (row && row.archived_at == null) return _hydrateAttribute(row);
    if (row && row.archived_at != null) return null;            // archived = excluded
    for (var i = 0; i < DEFAULT_ATTRIBUTES.length; i += 1) {
      if (DEFAULT_ATTRIBUTES[i].slug === slug) {
        return {
          slug:        DEFAULT_ATTRIBUTES[i].slug,
          label:       DEFAULT_ATTRIBUTES[i].label,
          source:      DEFAULT_ATTRIBUTES[i].source,
          format:      DEFAULT_ATTRIBUTES[i].format,
          archived_at: null,
          created_at:  0,
          updated_at:  0,
        };
      }
    }
    return null;
  }

  async function _upsertList(sessionHash, customerId, productIds, now) {
    var existing = await _getListByHash(sessionHash);
    var idsJson = JSON.stringify(productIds);
    if (existing) {
      // Customer id only floats forward — once a basket is claimed by
      // an authenticated shopper the column stays populated even if a
      // later anonymous mutation reaches the same session hash (the
      // session cookie is per-device; the customer id is per-account).
      var nextCustomerId = existing.customer_id != null ? existing.customer_id : customerId;
      await query(
        "UPDATE compare_lists SET product_ids_json = ?1, customer_id = ?2, updated_at = ?3 " +
        "WHERE session_id_hash = ?4",
        [idsJson, nextCustomerId, now, sessionHash],
      );
    } else {
      await query(
        "INSERT INTO compare_lists (id, session_id_hash, customer_id, product_ids_json, " +
        "created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        [b.uuid.v7(), sessionHash, customerId, idsJson, now],
      );
    }
    return _hydrateList(await _getListByHash(sessionHash));
  }

  return {

    MAX_COMPARE:              MAX_COMPARE,
    ATTRIBUTE_SOURCES:        ATTRIBUTE_SOURCES,
    ATTRIBUTE_FORMATS:        ATTRIBUTE_FORMATS,
    DEFAULT_ATTRIBUTE_SLUGS:  DEFAULT_ATTRIBUTE_SLUGS,

    // -- addToCompare ---------------------------------------------------
    //
    // Push a product onto the session's compare basket. Idempotent —
    // a repeat add of the same product id is a no-op (the storefront's
    // tap surface may re-fire while the response is in flight; the
    // primitive collapses the duplicate so the basket order stays
    // stable). Refuses with `error.code = "COMPARE_FULL"` when the
    // basket is at the 4-item cap.
    addToCompare: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("product-compare.addToCompare: input object required");
      }
      var sessionId  = _sessionId(input.session_id);
      var productId  = _uuid(input.product_id, "product_id");
      var customerId = _optionalUuid(input.customer_id == null ? null : input.customer_id, "customer_id");
      var sessionHash = _hashSession(sessionId);

      var existing = await _getListByHash(sessionHash);
      var ids = [];
      if (existing) {
        try { ids = JSON.parse(existing.product_ids_json || "[]"); }
        catch (_e) { ids = []; }
        if (!Array.isArray(ids)) ids = [];
      }
      if (ids.indexOf(productId) !== -1) {
        // Idempotent re-add — bump updated_at so the cleanup sweep
        // sees fresh activity but don't grow the basket.
        return await _upsertList(sessionHash, customerId, ids, _now());
      }
      if (ids.length >= MAX_COMPARE) {
        var fullErr = new Error(
          "product-compare.addToCompare: basket is full (max " + MAX_COMPARE +
          " products); remove an entry before adding another"
        );
        fullErr.code = "COMPARE_FULL";
        throw fullErr;
      }
      ids.push(productId);
      return await _upsertList(sessionHash, customerId, ids, _now());
    },

    // -- removeFromCompare ----------------------------------------------
    //
    // Drop a product from the session's basket. Idempotent — removing
    // a product that isn't in the basket is a no-op (the storefront's
    // multi-tap "remove" surface may re-fire). Returns the updated
    // list (or the empty-basket shape when the basket didn't exist).
    removeFromCompare: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("product-compare.removeFromCompare: input object required");
      }
      var sessionId = _sessionId(input.session_id);
      var productId = _uuid(input.product_id, "product_id");
      var sessionHash = _hashSession(sessionId);

      var existing = await _getListByHash(sessionHash);
      if (!existing) {
        return {
          id:               null,
          session_id_hash:  sessionHash,
          customer_id:      null,
          product_ids:      [],
          created_at:       0,
          updated_at:       0,
        };
      }
      var ids;
      try { ids = JSON.parse(existing.product_ids_json || "[]"); }
      catch (_e) { ids = []; }
      if (!Array.isArray(ids)) ids = [];
      var idx = ids.indexOf(productId);
      if (idx === -1) {
        // Idempotent — return the current basket without churning
        // updated_at.
        return _hydrateList(existing);
      }
      ids.splice(idx, 1);
      return await _upsertList(sessionHash, existing.customer_id, ids, _now());
    },

    // -- getCompareList -------------------------------------------------
    //
    // Read the current basket for a session. Returns the empty-basket
    // shape on miss so the storefront's compare-table page can render
    // an empty state without a separate null branch.
    getCompareList: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("product-compare.getCompareList: input object required");
      }
      var sessionId = _sessionId(input.session_id);
      var sessionHash = _hashSession(sessionId);
      var existing = await _getListByHash(sessionHash);
      if (!existing) {
        return {
          id:               null,
          session_id_hash:  sessionHash,
          customer_id:      null,
          product_ids:      [],
          created_at:       0,
          updated_at:       0,
        };
      }
      return _hydrateList(existing);
    },

    // -- clearCompareList -----------------------------------------------
    //
    // Drop the basket for a session. Returns `{ cleared: <count> }`
    // (0 when no basket existed, 1 otherwise) so the caller can
    // confirm the action without re-reading.
    clearCompareList: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("product-compare.clearCompareList: input object required");
      }
      var sessionId = _sessionId(input.session_id);
      var sessionHash = _hashSession(sessionId);
      var r = await query(
        "DELETE FROM compare_lists WHERE session_id_hash = ?1",
        [sessionHash],
      );
      return { cleared: Number(r.rowCount || 0) };
    },

    // -- compareTable ---------------------------------------------------
    //
    // Resolve the side-by-side comparison table for a session's
    // basket. Reads each product via the injected `catalog` handle,
    // walks the requested attributes (defaulting to the seven baked-
    // in defaults), and shapes the result as
    // `{ products, rows: [{ attribute, values_per_product }] }` so
    // the storefront's template paints one cell per (attribute,
    // product) pair. Refuses when no catalog is wired (the basket
    // verbs work standalone, but the table view needs product data).
    compareTable: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("product-compare.compareTable: input object required");
      }
      if (!catalog) {
        throw new TypeError("product-compare.compareTable: opts.catalog must be wired to resolve the compare table");
      }
      var sessionId = _sessionId(input.session_id);
      var sessionHash = _hashSession(sessionId);

      // Attribute selection. When the caller omits `attributes` we
      // fall back to the seven baked-in defaults. When supplied, we
      // resolve each slug against the operator-defined catalog +
      // defaults; an unknown slug throws so the caller catches the
      // typo at request time rather than rendering a silently-empty
      // column.
      var requested;
      if (input.attributes == null) {
        requested = DEFAULT_ATTRIBUTE_SLUGS.slice();
      } else {
        if (!Array.isArray(input.attributes) || input.attributes.length === 0) {
          throw new TypeError("product-compare.compareTable: attributes must be a non-empty array of slugs when provided");
        }
        requested = [];
        var seen = Object.create(null);
        for (var i = 0; i < input.attributes.length; i += 1) {
          var slug = _slug(input.attributes[i], "attributes[" + i + "]");
          if (seen[slug]) {
            throw new TypeError(
              "product-compare.compareTable: attributes[" + i + "] " + JSON.stringify(slug) +
              " duplicates a previous entry"
            );
          }
          seen[slug] = true;
          requested.push(slug);
        }
      }

      // Resolve the descriptors before the catalog lookups so an
      // unknown slug fails fast.
      var attrs = [];
      for (var j = 0; j < requested.length; j += 1) {
        var attr = await _resolveAttribute(requested[j]);
        if (!attr) {
          throw new TypeError(
            "product-compare.compareTable: attribute slug " + JSON.stringify(requested[j]) +
            " is not defined (operator must call defineCompareAttribute or pick a default)"
          );
        }
        attrs.push(attr);
      }

      var listRow = await _getListByHash(sessionHash);
      var productIds = [];
      if (listRow) {
        try { productIds = JSON.parse(listRow.product_ids_json || "[]"); }
        catch (_e) { productIds = []; }
      }
      if (!Array.isArray(productIds)) productIds = [];

      // Walk the basket's product ids through the catalog. A missing
      // product (deleted between basket-add and table-render) lands
      // as null in the products list AND every attribute cell — the
      // storefront's renderer paints "Product unavailable" without a
      // separate filter pass.
      var products = [];
      for (var k = 0; k < productIds.length; k += 1) {
        var pid = productIds[k];
        var prod = null;
        try { prod = await catalog.getProduct(pid); }
        catch (_e) { prod = null; }
        products.push(prod);
      }

      var rows = [];
      for (var m = 0; m < attrs.length; m += 1) {
        var thisAttr = attrs[m];
        var values = [];
        for (var n = 0; n < products.length; n += 1) {
          values.push(_resolveAttributeValue(products[n], thisAttr));
        }
        rows.push({
          attribute: {
            slug:   thisAttr.slug,
            label:  thisAttr.label,
            source: thisAttr.source,
            format: thisAttr.format,
          },
          values_per_product: values,
        });
      }

      return {
        session_id_hash: sessionHash,
        product_ids:     productIds.slice(),
        products:        products,
        rows:            rows,
      };
    },

    // -- defineCompareAttribute -----------------------------------------
    //
    // Register / update an operator-defined attribute. Upsert
    // semantics on `slug` — re-defining the same slug updates the
    // row in place. An operator can shadow a baked-in default by
    // re-defining its slug (point `price` at a metadata bag key, for
    // instance); the new descriptor takes precedence on subsequent
    // `compareTable` reads.
    defineCompareAttribute: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("product-compare.defineCompareAttribute: input object required");
      }
      var slug   = _slug(input.slug, "slug");
      var label  = _label(input.label);
      var source = _source(input.source);
      var format = _format(input.format);
      var now    = _now();

      var existing = await _getAttributeBySlug(slug);
      if (existing) {
        await query(
          "UPDATE compare_attributes SET label = ?1, source = ?2, format = ?3, " +
          "archived_at = NULL, updated_at = ?4 WHERE slug = ?5",
          [label, source, format, now, slug],
        );
      } else {
        await query(
          "INSERT INTO compare_attributes (slug, label, source, format, archived_at, " +
          "created_at, updated_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)",
          [slug, label, source, format, now],
        );
      }
      return _hydrateAttribute(await _getAttributeBySlug(slug));
    },

    // -- listAttributes -------------------------------------------------
    //
    // Operator-facing read of the active attribute catalog. Merges
    // the baked-in defaults with the operator-defined rows; an
    // operator-defined slug shadows the same-slug default. Archived
    // rows are excluded. Returned in alphabetical-by-slug order so
    // the admin UI table is stable across releases.
    listAttributes: async function () {
      var rows = (await query(
        "SELECT * FROM compare_attributes WHERE archived_at IS NULL ORDER BY slug ASC",
        [],
      )).rows;
      var bySlug = Object.create(null);
      var i;
      for (i = 0; i < DEFAULT_ATTRIBUTES.length; i += 1) {
        bySlug[DEFAULT_ATTRIBUTES[i].slug] = {
          slug:        DEFAULT_ATTRIBUTES[i].slug,
          label:       DEFAULT_ATTRIBUTES[i].label,
          source:      DEFAULT_ATTRIBUTES[i].source,
          format:      DEFAULT_ATTRIBUTES[i].format,
          archived_at: null,
          created_at:  0,
          updated_at:  0,
          default:     true,
        };
      }
      for (i = 0; i < rows.length; i += 1) {
        var h = _hydrateAttribute(rows[i]);
        h.default = false;
        bySlug[h.slug] = h;
      }
      var out = Object.keys(bySlug).sort().map(function (k) { return bySlug[k]; });
      return out;
    },

    // -- recordImpression -----------------------------------------------
    //
    // Append a "this product was placed into a compare basket"
    // event. Drives `popularCompares({ from, to })`. The session id
    // is namespace-hashed identically to the basket-table write
    // path so an operator-side rollup can detect "this product is
    // compared from many distinct sessions" by counting distinct
    // `session_id_hash` values within a window.
    recordImpression: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("product-compare.recordImpression: input object required");
      }
      var productId  = _uuid(input.product_id, "product_id");
      var sourceKind = _sourceKind(input.source_kind);
      var sessionId  = _sessionId(input.session_id);
      var sessionHash = _hashSession(sessionId);
      var now        = _now();
      var id         = b.uuid.v7();
      await query(
        "INSERT INTO compare_impressions (id, product_id, source_kind, session_id_hash, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, productId, sourceKind, sessionHash, now],
      );
      return {
        id:               id,
        product_id:       productId,
        source_kind:      sourceKind,
        session_id_hash:  sessionHash,
        occurred_at:      now,
      };
    },

    // -- popularCompares ------------------------------------------------
    //
    // Rollup the impressions ledger over a window. Returns
    // `[ { product_id, impressions, distinct_sessions } ]` sorted by
    // impressions desc + product_id asc (the tiebreak keeps the
    // ordering deterministic across releases). The distinct-sessions
    // count lets the merchandising widget weight "many shoppers
    // showed interest" over "one shopper compared this 50 times in a
    // row" without an extra query.
    popularCompares: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("product-compare.popularCompares: input object required");
      }
      var from  = _epochMs(input.from, "from");
      var to    = _epochMs(input.to,   "to");
      if (from > to) {
        throw new TypeError("product-compare.popularCompares: from must be <= to");
      }
      var limit = _limit(input.limit, "limit");

      var rows = (await query(
        "SELECT product_id, COUNT(*) AS n, COUNT(DISTINCT session_id_hash) AS d " +
        "FROM compare_impressions WHERE occurred_at >= ?1 AND occurred_at <= ?2 " +
        "GROUP BY product_id ORDER BY n DESC, product_id ASC LIMIT ?3",
        [from, to, limit],
      )).rows;

      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        out.push({
          product_id:         rows[i].product_id,
          impressions:        Number(rows[i].n),
          distinct_sessions:  Number(rows[i].d),
        });
      }
      return out;
    },

    // -- cleanupOlderThan -----------------------------------------------
    //
    // Operator scheduler entry point. Sweeps abandoned compare
    // baskets whose `updated_at` is older than the supplied age, plus
    // the impressions ledger past the same threshold. Operators
    // typically wire this to a daily cron with `days=90` so the
    // tables stay bounded as the shopper population grows. Returns
    // `{ baskets_removed, impressions_removed }` so the operator
    // dashboard can render the sweep's footprint.
    cleanupOlderThan: async function (days) {
      _days(days);
      var threshold = _now() - C.TIME.days(days);
      var lists = await query(
        "DELETE FROM compare_lists WHERE updated_at < ?1",
        [threshold],
      );
      var impressions = await query(
        "DELETE FROM compare_impressions WHERE occurred_at < ?1",
        [threshold],
      );
      return {
        baskets_removed:     Number(lists.rowCount || 0),
        impressions_removed: Number(impressions.rowCount || 0),
      };
    },
  };
}

module.exports = {
  create:                   create,
  MAX_COMPARE:              MAX_COMPARE,
  MIN_COMPARE_FOR_TABLE:    MIN_COMPARE_FOR_TABLE,
  ATTRIBUTE_SOURCES:        ATTRIBUTE_SOURCES,
  ATTRIBUTE_FORMATS:        ATTRIBUTE_FORMATS,
  DEFAULT_ATTRIBUTES:       DEFAULT_ATTRIBUTES,
  DEFAULT_ATTRIBUTE_SLUGS:  DEFAULT_ATTRIBUTE_SLUGS,
  SESSION_NAMESPACE:        SESSION_NAMESPACE,
};
