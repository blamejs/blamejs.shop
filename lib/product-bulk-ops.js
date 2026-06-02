"use strict";
/**
 * @module shop.productBulkOps
 * @title  Product bulk operations — operator-side mass-mutation surface
 *
 * @intro
 *   Composes on top of the `catalog` primitive to add the bulk mutation
 *   operations an operator console needs when a single change has to
 *   land across hundreds of products at once:
 *
 *     bulkSetPrice       — set a flat new amount_minor on every matched
 *                          variant in the given currency (versioned —
 *                          the prior price is closed via the catalog
 *                          primitive's `prices.set` so price history is
 *                          preserved).
 *     bulkAdjustPrice    — apply a percent delta (e.g. -1500 bps for a
 *                          15% markdown) to every matched variant's
 *                          current price in the given currency. The new
 *                          amount is rounded half-even in minor units
 *                          via b.money; the floor is 0 (no negative
 *                          prices). Variants without a current price in
 *                          the target currency are skipped.
 *     bulkArchive        — set products.status='archived' on every
 *                          matched row that isn't already archived.
 *     bulkUnarchive      — restore archived products to 'draft'.
 *     bulkAddTag         — insert (product_id, tag) into product_tags
 *                          for every matched product. Idempotent — the
 *                          composite PK refuses duplicate tags on the
 *                          same product, and the affected_count reflects
 *                          actual inserts.
 *     bulkRemoveTag      — delete (product_id, tag) rows. Idempotent on
 *                          the no-such-tag case.
 *     bulkSetInventory   — upsert inventory.stock_on_hand to a flat
 *                          value for every variant of every matched
 *                          product. Variants without an inventory row
 *                          get one created at the target stock.
 *     previewFilter      — resolve the filter to the matched product
 *                          rows + count without mutating anything.
 *                          The operator console renders this as the
 *                          "you're about to change N rows" affordance.
 *     auditTrail         — read the append-only product_bulk_audit
 *                          rows back, optionally narrowed by kind /
 *                          since / limit.
 *
 *   Filter shape `{ skus?, vendor_slug?, category?, tag_any?, tag_all? }`:
 *
 *     - `skus`         — array of SKU strings. The matched products are
 *                        the parents of variants matching any of these
 *                        SKUs. Caps at 1000 entries per call.
 *     - `vendor_slug`  — single slug string. Matches products whose any
 *                        variant SKU is assigned to that vendor in
 *                        `vendor_skus`.
 *     - `category`     — single category string. Matches products with
 *                        a row in `product_categories` for that
 *                        category.
 *     - `tag_any`      — array of tag strings; matches products with at
 *                        least ONE of the tags.
 *     - `tag_all`      — array of tag strings; matches products with
 *                        EVERY tag.
 *
 *   Multiple filter keys AND together. An empty filter `{}` is refused
 *   to refuse a "modify every product in the catalog" footgun — the
 *   operator passes an explicit `skus: [...]` to opt into a global
 *   change.
 *
 *   Pre-flight cap: the resolved product set is capped at
 *   `MAX_BULK_ROWS` (default 1000) BEFORE any write fires. A filter
 *   that resolves to a larger set throws — the operator narrows the
 *   filter or raises the cap explicitly via `opts.maxBulkRows` at
 *   create() time.
 *
 *   Audit trail: every bulk write inserts one row into
 *   `product_bulk_audit` with the resolved filter (JSON), the op
 *   parameters (JSON), and the actual affected count. The id is a v7
 *   UUID so the log sorts by insertion order.
 *
 *   Atomicity story: pre-flight validation + cap check fire BEFORE any
 *   mutation. Once the per-row writes begin, each row's write runs in
 *   sequence; a partial failure (e.g. SQLite reports a CHECK constraint
 *   violation on row K) leaves rows 0..K-1 written and rows K..N
 *   unwritten. The audit row reflects the actual affected_count from
 *   `rowCount` summing, so post-hoc reconciliation sees the true tally.
 *   D1's per-statement boundary makes batch-level transactions
 *   unavailable; the in-batch ordering keeps the failure mode honest.
 *
 *   Pricing math: `bulkAdjustPrice` takes `percent_bps` (basis points)
 *   so the operator passes integer values (-1500 = -15%, +500 = +5%).
 *   The new amount is `Math.round(prior * (10000 + percent_bps) /
 *   10000)` clamped to 0. Tie-rounding follows `Math.round` (half-up
 *   towards +Infinity for positive numbers); the catalog primitive
 *   stores integer amount_minor only, so the round is unavoidable.
 *
 *   The factory accepts:
 *     query        — query function shared with `catalog`. Defaults to
 *                    `b.externalDb`.
 *     catalog      — REQUIRED. The catalog handle, used for variant
 *                    lookups and price set.
 *     maxBulkRows  — OPTIONAL. Caps the resolved product set per call
 *                    (default 1000).
 *
 * @composes  b.guardUuid, b.uuid.v7, b.safeSql, catalog.prices.set
 */

var b = require("./vendor/blamejs");

var SLUG_RE       = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;
var SKU_RE        = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var TAG_RE        = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
var CATEGORY_RE   = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
var CURRENCY_RE   = /^[A-Z]{3}$/;
var DEFAULT_CAP   = 1000;
var MAX_CAP       = 10000;
var MAX_TAG_LIST  = 32;
var MAX_SKU_LIST  = 1000;
var MIN_BPS       = -10000;     // -100%, clamped to zero floor on apply
var MAX_BPS       = 1000000;    // +10000%, soft sanity ceiling
var AUDIT_KINDS   = Object.freeze([
  "set_price", "adjust_price", "archive", "unarchive",
  "add_tag", "remove_tag", "set_inventory",
]);

// ---- validators ----------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("productBulkOps: " + label + " — " + (e && e.message || "invalid UUID")); }
}
function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("productBulkOps: " + label + " must match /^[a-z0-9][a-z0-9-]*[a-z0-9]?$/ (lowercase alnum + dash, ≤ 200 chars)");
  }
}
function _sku(s, label) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("productBulkOps: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ 128 chars)");
  }
}
function _tag(s, label) {
  if (typeof s !== "string" || !TAG_RE.test(s)) {
    throw new TypeError("productBulkOps: " + label + " must match /^[a-z0-9][a-z0-9-]*[a-z0-9]?$/ (lowercase alnum + dash, 1-64 chars)");
  }
}
function _category(s, label) {
  if (typeof s !== "string" || !CATEGORY_RE.test(s)) {
    throw new TypeError("productBulkOps: " + label + " must match /^[a-z0-9][a-z0-9-]*[a-z0-9]?$/ (lowercase alnum + dash, 1-64 chars)");
  }
}
function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("productBulkOps: currency must be a 3-letter ISO 4217 code (uppercase)");
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("productBulkOps: " + label + " must be a non-negative integer");
  }
}
function _bps(n) {
  if (!Number.isInteger(n) || n < MIN_BPS || n > MAX_BPS) {
    throw new TypeError("productBulkOps: percent_bps must be an integer in [" + MIN_BPS + ", " + MAX_BPS + "]");
  }
}
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}
function _id()  { return b.uuid.v7(); }

// ---- filter ---------------------------------------------------------------

function _validateFilter(filter, label) {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new TypeError("productBulkOps." + label + ": filter object required");
  }
  var keys = Object.keys(filter);
  if (keys.length === 0) {
    throw new TypeError("productBulkOps." + label + ": filter must specify at least one of skus / vendor_slug / category / tag_any / tag_all");
  }
  if (filter.skus !== undefined) {
    if (!Array.isArray(filter.skus) || filter.skus.length === 0) {
      throw new TypeError("productBulkOps." + label + ": filter.skus must be a non-empty array");
    }
    if (filter.skus.length > MAX_SKU_LIST) {
      throw new TypeError("productBulkOps." + label + ": filter.skus must be ≤ " + MAX_SKU_LIST + " entries");
    }
    for (var i = 0; i < filter.skus.length; i += 1) {
      _sku(filter.skus[i], "filter.skus[" + i + "]");
    }
  }
  if (filter.vendor_slug !== undefined) {
    _slug(filter.vendor_slug, "filter.vendor_slug");
  }
  if (filter.category !== undefined) {
    _category(filter.category, "filter.category");
  }
  if (filter.tag_any !== undefined) {
    if (!Array.isArray(filter.tag_any) || filter.tag_any.length === 0) {
      throw new TypeError("productBulkOps." + label + ": filter.tag_any must be a non-empty array");
    }
    if (filter.tag_any.length > MAX_TAG_LIST) {
      throw new TypeError("productBulkOps." + label + ": filter.tag_any must be ≤ " + MAX_TAG_LIST + " entries");
    }
    for (var ai = 0; ai < filter.tag_any.length; ai += 1) {
      _tag(filter.tag_any[ai], "filter.tag_any[" + ai + "]");
    }
  }
  if (filter.tag_all !== undefined) {
    if (!Array.isArray(filter.tag_all) || filter.tag_all.length === 0) {
      throw new TypeError("productBulkOps." + label + ": filter.tag_all must be a non-empty array");
    }
    if (filter.tag_all.length > MAX_TAG_LIST) {
      throw new TypeError("productBulkOps." + label + ": filter.tag_all must be ≤ " + MAX_TAG_LIST + " entries");
    }
    for (var li = 0; li < filter.tag_all.length; li += 1) {
      _tag(filter.tag_all[li], "filter.tag_all[" + li + "]");
    }
  }
  // Reject unknown keys so a typo doesn't silently widen the match.
  var allowed = { skus: 1, vendor_slug: 1, category: 1, tag_any: 1, tag_all: 1 };
  for (var k = 0; k < keys.length; k += 1) {
    if (!allowed[keys[k]]) {
      throw new TypeError("productBulkOps." + label + ": unknown filter key '" + keys[k] + "'");
    }
  }
}

// Resolve the filter to a sorted array of product ids. Each filter
// key contributes a candidate set; the result is the intersection of
// those sets. An unfiltered key contributes "all product ids" — but
// since _validateFilter refuses the empty filter, at least one
// constraint is always present.
function _resolveFilter(query, filter, cap, label) {
  var keysUsed = [];
  if (filter.skus       !== undefined) keysUsed.push("skus");
  if (filter.vendor_slug !== undefined) keysUsed.push("vendor_slug");
  if (filter.category   !== undefined) keysUsed.push("category");
  if (filter.tag_any    !== undefined) keysUsed.push("tag_any");
  if (filter.tag_all    !== undefined) keysUsed.push("tag_all");

  return _resolveFilterAsync(query, filter, keysUsed, cap, label);
}

async function _resolveFilterAsync(query, filter, keysUsed, cap, label) {
  var sets = [];
  for (var i = 0; i < keysUsed.length; i += 1) {
    var key = keysUsed[i];
    var ids = await _idsForKey(query, key, filter[key]);
    sets.push(ids);
  }
  // Intersect.
  var result;
  if (sets.length === 1) {
    result = sets[0];
  } else {
    var smallest = sets[0];
    for (var s = 1; s < sets.length; s += 1) {
      if (sets[s].length < smallest.length) smallest = sets[s];
    }
    var lookup = {};
    smallest.forEach(function (id) { lookup[id] = 1; });
    for (var j = 0; j < sets.length; j += 1) {
      if (sets[j] === smallest) continue;
      var next = {};
      for (var n = 0; n < sets[j].length; n += 1) {
        if (lookup[sets[j][n]]) next[sets[j][n]] = 1;
      }
      lookup = next;
    }
    result = Object.keys(lookup);
  }
  result.sort();
  if (result.length > cap) {
    throw new TypeError("productBulkOps." + label + ": filter resolved to " + result.length + " products — exceeds cap of " + cap + " per call. Narrow the filter or raise opts.maxBulkRows at create() time.");
  }
  return result;
}

// Build the candidate id set for one filter key. Each clause produces
// distinct product ids; duplicates inside a result set are collapsed
// before return.
async function _idsForKey(query, key, value) {
  var rows;
  var seen;
  var out;
  var i;
  if (key === "skus") {
    var placeholders = [];
    var params = [];
    for (i = 0; i < value.length; i += 1) {
      placeholders.push("?" + (i + 1));
      params.push(value[i]);
    }
    rows = (await query(
      "SELECT DISTINCT product_id FROM variants WHERE sku IN (" + placeholders.join(", ") + ")",
      params,
    )).rows;
  } else if (key === "vendor_slug") {
    rows = (await query(
      "SELECT DISTINCT v.product_id FROM variants v " +
      "INNER JOIN vendor_skus vs ON vs.sku = v.sku " +
      "WHERE vs.vendor_slug = ?1",
      [value],
    )).rows;
  } else if (key === "category") {
    rows = (await query(
      "SELECT product_id FROM product_categories WHERE category = ?1",
      [value],
    )).rows;
  } else if (key === "tag_any") {
    var ph = [];
    var pa = [];
    for (i = 0; i < value.length; i += 1) {
      ph.push("?" + (i + 1));
      pa.push(value[i]);
    }
    rows = (await query(
      "SELECT DISTINCT product_id FROM product_tags WHERE tag IN (" + ph.join(", ") + ")",
      pa,
    )).rows;
  } else if (key === "tag_all") {
    // Products with every requested tag — group by product_id and
    // require COUNT(DISTINCT tag) == requested length.
    var ph2 = [];
    var pa2 = [];
    for (i = 0; i < value.length; i += 1) {
      ph2.push("?" + (i + 1));
      pa2.push(value[i]);
    }
    pa2.push(value.length);
    rows = (await query(
      "SELECT product_id FROM product_tags WHERE tag IN (" + ph2.join(", ") + ") " +
      "GROUP BY product_id HAVING COUNT(DISTINCT tag) = ?" + (value.length + 1),
      pa2,
    )).rows;
  } else {
    rows = [];
  }
  seen = {};
  out = [];
  for (i = 0; i < rows.length; i += 1) {
    var pid = rows[i].product_id;
    if (!seen[pid]) { seen[pid] = 1; out.push(pid); }
  }
  return out;
}

// ---- factory --------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.catalog) {
    throw new TypeError("productBulkOps.create: catalog handle required");
  }
  var catalog = opts.catalog;
  var maxBulkRows = opts.maxBulkRows == null ? DEFAULT_CAP : opts.maxBulkRows;
  if (!Number.isInteger(maxBulkRows) || maxBulkRows <= 0 || maxBulkRows > MAX_CAP) {
    throw new TypeError("productBulkOps.create: maxBulkRows must be a positive integer ≤ " + MAX_CAP);
  }
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Write one append-only audit row. Drop-noise: a failed audit-row
  // insert here is a hard error — the audit trail is the contract
  // every bulk op honours. The catalog primitive owns the rollback
  // story for the data writes; this row is the breadcrumb so the
  // operator can reconcile after the fact.
  async function _writeAudit(kind, filter, params, affectedCount, actorId) {
    var id = _id();
    var ts = _now();
    await query(
      "INSERT INTO product_bulk_audit " +
      "(id, kind, filter_json, params_json, affected_count, performed_at, actor_id) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      [
        id, kind,
        JSON.stringify(filter || {}),
        JSON.stringify(params || {}),
        affectedCount, ts,
        actorId == null ? null : actorId,
      ],
    );
    return {
      id:              id,
      kind:            kind,
      filter:          filter,
      params:          params,
      affected_count:  affectedCount,
      performed_at:    ts,
      actor_id:        actorId == null ? null : actorId,
    };
  }

  function _maybeActor(input) {
    if (input.actor_id == null) return null;
    return _uuid(input.actor_id, "actor_id");
  }

  // Resolve filter → product ids, cap-checked, ready for write loop.
  async function _matchProductIds(filter, label) {
    _validateFilter(filter, label);
    return await _resolveFilter(query, filter, maxBulkRows, label);
  }

  // Load every variant row for the matched product set. Variants are
  // the unit price + inventory mutations target; products own the
  // status + tag set + category set.
  async function _variantsForProducts(productIds) {
    if (productIds.length === 0) return [];
    var ph = [];
    var pa = [];
    for (var i = 0; i < productIds.length; i += 1) {
      ph.push("?" + (i + 1));
      pa.push(productIds[i]);
    }
    var r = await query(
      "SELECT id, product_id, sku FROM variants WHERE product_id IN (" + ph.join(", ") + ")",
      pa,
    );
    return r.rows;
  }

  return {
    AUDIT_KINDS:   AUDIT_KINDS,
    MAX_BULK_ROWS: maxBulkRows,
    DEFAULT_CAP:   DEFAULT_CAP,

    // Read-only — render the matched product set for an operator
    // preview affordance. Never mutates anything.
    previewFilter: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("productBulkOps.previewFilter: input object required");
      var filter = input.filter;
      _validateFilter(filter, "previewFilter");
      var ids = await _resolveFilter(query, filter, maxBulkRows, "previewFilter");
      if (ids.length === 0) {
        return { matched: 0, product_ids: [], products: [] };
      }
      var ph = [];
      var pa = [];
      for (var i = 0; i < ids.length; i += 1) {
        ph.push("?" + (i + 1));
        pa.push(ids[i]);
      }
      var r = await query(
        "SELECT * FROM products WHERE id IN (" + ph.join(", ") + ") ORDER BY id ASC",
        pa,
      );
      return {
        matched:     r.rows.length,
        product_ids: ids,
        products:    r.rows,
      };
    },

    // Set a flat amount_minor on every matched variant in the given
    // currency. Goes through catalog.prices.set so the prior price
    // is versioned (closed with effective_until) rather than
    // overwritten.
    bulkSetPrice: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("productBulkOps.bulkSetPrice: input object required");
      var filter = input.filter;
      _currency(input.currency);
      _nonNegInt(input.amount_minor, "amount_minor");
      var actorId = _maybeActor(input);
      var productIds = await _matchProductIds(filter, "bulkSetPrice");
      var variants = await _variantsForProducts(productIds);
      var affected = 0;
      for (var i = 0; i < variants.length; i += 1) {
        await catalog.prices.set(variants[i].id, {
          currency:     input.currency,
          amount_minor: input.amount_minor,
        });
        affected += 1;
      }
      var paramsOut = { currency: input.currency, amount_minor: input.amount_minor };
      var auditRow = await _writeAudit("set_price", filter, paramsOut, affected, actorId);
      return {
        affected_count:   affected,
        matched_products: productIds.length,
        matched_variants: variants.length,
        audit_id:         auditRow.id,
      };
    },

    // Apply a percent_bps delta to every matched variant's CURRENT
    // price in the given currency. Variants without a current price
    // in the target currency are skipped (they don't have a "before"
    // amount to multiply against). The new amount = current ×
    // (1 + percent_bps/10000), rounded half-even in minor units via
    // b.money, and floored at 0.
    bulkAdjustPrice: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("productBulkOps.bulkAdjustPrice: input object required");
      var filter = input.filter;
      _currency(input.currency);
      _bps(input.percent_bps);
      var actorId = _maybeActor(input);
      var productIds = await _matchProductIds(filter, "bulkAdjustPrice");
      var variants = await _variantsForProducts(productIds);
      var affected = 0;
      var skipped = 0;
      for (var i = 0; i < variants.length; i += 1) {
        var current = await catalog.prices.current(variants[i].id, input.currency);
        if (!current) { skipped += 1; continue; }
        var next = Number(
          b.money.fromMinorUnits(BigInt(current.amount_minor), input.currency)
            .multiply([BigInt(10000 + input.percent_bps), 10000n], { rounding: "half-even" })
            .toMinorUnits()
        );
        if (next < 0) next = 0;
        await catalog.prices.set(variants[i].id, {
          currency:     input.currency,
          amount_minor: next,
        });
        affected += 1;
      }
      var paramsOut = { currency: input.currency, percent_bps: input.percent_bps };
      var auditRow = await _writeAudit("adjust_price", filter, paramsOut, affected, actorId);
      return {
        affected_count:   affected,
        skipped_count:    skipped,
        matched_products: productIds.length,
        matched_variants: variants.length,
        audit_id:         auditRow.id,
      };
    },

    bulkArchive: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("productBulkOps.bulkArchive: input object required");
      var filter = input.filter;
      var actorId = _maybeActor(input);
      var productIds = await _matchProductIds(filter, "bulkArchive");
      if (productIds.length === 0) {
        var emptyRow = await _writeAudit("archive", filter, {}, 0, actorId);
        return { affected_count: 0, matched_products: 0, audit_id: emptyRow.id };
      }
      var ph = [];
      var pa = [];
      for (var i = 0; i < productIds.length; i += 1) {
        ph.push("?" + (i + 1));
        pa.push(productIds[i]);
      }
      pa.push(_now());
      var r = await query(
        "UPDATE products SET status = 'archived', updated_at = ?" + (productIds.length + 1) + " " +
        "WHERE id IN (" + ph.join(", ") + ") AND status != 'archived'",
        pa,
      );
      var affected = r.rowCount;
      var auditRow = await _writeAudit("archive", filter, {}, affected, actorId);
      return {
        affected_count:   affected,
        matched_products: productIds.length,
        audit_id:         auditRow.id,
      };
    },

    bulkUnarchive: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("productBulkOps.bulkUnarchive: input object required");
      var filter = input.filter;
      var actorId = _maybeActor(input);
      var productIds = await _matchProductIds(filter, "bulkUnarchive");
      if (productIds.length === 0) {
        var emptyRow = await _writeAudit("unarchive", filter, {}, 0, actorId);
        return { affected_count: 0, matched_products: 0, audit_id: emptyRow.id };
      }
      var ph = [];
      var pa = [];
      for (var i = 0; i < productIds.length; i += 1) {
        ph.push("?" + (i + 1));
        pa.push(productIds[i]);
      }
      pa.push(_now());
      var r = await query(
        "UPDATE products SET status = 'draft', updated_at = ?" + (productIds.length + 1) + " " +
        "WHERE id IN (" + ph.join(", ") + ") AND status = 'archived'",
        pa,
      );
      var affected = r.rowCount;
      var auditRow = await _writeAudit("unarchive", filter, {}, affected, actorId);
      return {
        affected_count:   affected,
        matched_products: productIds.length,
        audit_id:         auditRow.id,
      };
    },

    // Insert (product_id, tag) for every matched product. The PK
    // refuses duplicates so a re-add is a no-op per row. We do the
    // insert one row at a time and count successes — INSERT OR
    // IGNORE keeps the loop forward-progressing without a per-row
    // SELECT-then-INSERT race.
    bulkAddTag: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("productBulkOps.bulkAddTag: input object required");
      var filter = input.filter;
      _tag(input.tag, "tag");
      var actorId = _maybeActor(input);
      var productIds = await _matchProductIds(filter, "bulkAddTag");
      var ts = _now();
      var affected = 0;
      for (var i = 0; i < productIds.length; i += 1) {
        var r = await query(
          "INSERT OR IGNORE INTO product_tags (product_id, tag, added_at) VALUES (?1, ?2, ?3)",
          [productIds[i], input.tag, ts],
        );
        affected += r.rowCount;
      }
      var paramsOut = { tag: input.tag };
      var auditRow = await _writeAudit("add_tag", filter, paramsOut, affected, actorId);
      return {
        affected_count:   affected,
        matched_products: productIds.length,
        audit_id:         auditRow.id,
      };
    },

    bulkRemoveTag: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("productBulkOps.bulkRemoveTag: input object required");
      var filter = input.filter;
      _tag(input.tag, "tag");
      var actorId = _maybeActor(input);
      var productIds = await _matchProductIds(filter, "bulkRemoveTag");
      if (productIds.length === 0) {
        var emptyRow = await _writeAudit("remove_tag", filter, { tag: input.tag }, 0, actorId);
        return { affected_count: 0, matched_products: 0, audit_id: emptyRow.id };
      }
      var ph = [];
      var pa = [];
      for (var i = 0; i < productIds.length; i += 1) {
        ph.push("?" + (i + 1));
        pa.push(productIds[i]);
      }
      pa.push(input.tag);
      var r = await query(
        "DELETE FROM product_tags WHERE product_id IN (" + ph.join(", ") + ") AND tag = ?" + (productIds.length + 1),
        pa,
      );
      var affected = r.rowCount;
      var auditRow = await _writeAudit("remove_tag", filter, { tag: input.tag }, affected, actorId);
      return {
        affected_count:   affected,
        matched_products: productIds.length,
        audit_id:         auditRow.id,
      };
    },

    // Upsert inventory.stock_on_hand to a flat value for every
    // variant of every matched product. Missing inventory rows are
    // created at the target stock. `stock_held` is preserved on
    // existing rows — the operator changes "on hand", not the
    // checkout-side reservation count.
    bulkSetInventory: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("productBulkOps.bulkSetInventory: input object required");
      var filter = input.filter;
      _nonNegInt(input.stock_on_hand, "stock_on_hand");
      var actorId = _maybeActor(input);
      var productIds = await _matchProductIds(filter, "bulkSetInventory");
      var variants = await _variantsForProducts(productIds);
      var ts = _now();
      var affected = 0;
      for (var i = 0; i < variants.length; i += 1) {
        var sku = variants[i].sku;
        var existing = (await query(
          "SELECT sku FROM inventory WHERE sku = ?1",
          [sku],
        )).rows[0];
        if (existing) {
          var u = await query(
            "UPDATE inventory SET stock_on_hand = ?1, updated_at = ?2 WHERE sku = ?3",
            [input.stock_on_hand, ts, sku],
          );
          affected += u.rowCount;
        } else {
          await query(
            "INSERT INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES (?1, ?2, 0, ?3)",
            [sku, input.stock_on_hand, ts],
          );
          affected += 1;
        }
      }
      var paramsOut = { stock_on_hand: input.stock_on_hand };
      var auditRow = await _writeAudit("set_inventory", filter, paramsOut, affected, actorId);
      return {
        affected_count:   affected,
        matched_products: productIds.length,
        matched_variants: variants.length,
        audit_id:         auditRow.id,
      };
    },

    // Append-only audit-trail reader. Narrow by kind / since / limit
    // / actor_id; default is "newest 50 across every kind".
    auditTrail: async function (opts2) {
      opts2 = opts2 || {};
      var clauses = [];
      var params = [];
      var idx = 1;
      if (opts2.kind !== undefined) {
        if (AUDIT_KINDS.indexOf(opts2.kind) === -1) {
          throw new TypeError("productBulkOps.auditTrail: kind must be one of " + AUDIT_KINDS.join(", "));
        }
        clauses.push("kind = ?" + (idx++));
        params.push(opts2.kind);
      }
      if (opts2.since !== undefined) {
        if (!Number.isInteger(opts2.since) || opts2.since < 0) {
          throw new TypeError("productBulkOps.auditTrail: since must be a non-negative epoch ms integer");
        }
        clauses.push("performed_at >= ?" + (idx++));
        params.push(opts2.since);
      }
      if (opts2.actor_id !== undefined) {
        var actor = _uuid(opts2.actor_id, "actor_id");
        clauses.push("actor_id = ?" + (idx++));
        params.push(actor);
      }
      var limit = opts2.limit == null ? 50 : opts2.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
        throw new TypeError("productBulkOps.auditTrail: limit must be 1..500");
      }
      var sql = "SELECT * FROM product_bulk_audit" +
        (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
        " ORDER BY performed_at DESC, id DESC LIMIT ?" + idx;
      params.push(limit);
      var r = await query(sql, params);
      return r.rows.map(function (row) {
        return {
          id:             row.id,
          kind:           row.kind,
          filter:         JSON.parse(row.filter_json),
          params:         JSON.parse(row.params_json),
          affected_count: row.affected_count,
          performed_at:   row.performed_at,
          actor_id:       row.actor_id,
        };
      });
    },

    // Small admin surface for the category join table — used by the
    // operator console to assign / remove a category from a product.
    // The bulk-ops primitive owns this because the table is its
    // domain (the filter resolution is the only consumer).
    categories: {
      assign: async function (productId, category) {
        _uuid(productId, "product_id");
        _category(category, "category");
        var ts = _now();
        await query(
          "INSERT OR IGNORE INTO product_categories (product_id, category, added_at) VALUES (?1, ?2, ?3)",
          [productId, category, ts],
        );
        return { product_id: productId, category: category, added_at: ts };
      },
      remove: async function (productId, category) {
        _uuid(productId, "product_id");
        _category(category, "category");
        var r = await query(
          "DELETE FROM product_categories WHERE product_id = ?1 AND category = ?2",
          [productId, category],
        );
        return { removed: r.rowCount };
      },
      listForProduct: async function (productId) {
        _uuid(productId, "product_id");
        var r = await query(
          "SELECT category FROM product_categories WHERE product_id = ?1 ORDER BY category ASC",
          [productId],
        );
        return r.rows.map(function (row) { return row.category; });
      },
    },

    // Same small admin surface for the tag table — operators address
    // single-product tag mutations through here; the bulk paths are
    // the loop-N variant.
    tags: {
      listForProduct: async function (productId) {
        _uuid(productId, "product_id");
        var r = await query(
          "SELECT tag FROM product_tags WHERE product_id = ?1 ORDER BY tag ASC",
          [productId],
        );
        return r.rows.map(function (row) { return row.tag; });
      },
    },
  };
}

module.exports = {
  create:        create,
  AUDIT_KINDS:   AUDIT_KINDS,
  DEFAULT_CAP:   DEFAULT_CAP,
  MAX_CAP:       MAX_CAP,
};
