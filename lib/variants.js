"use strict";
/**
 * Product variants — normalized option-axis layer on top of
 * `catalog.products`. A T-shirt product has axes (color, size) with
 * options (red/blue/green × S/M/L/XL) producing the cartesian
 * product of 12 variant SKUs. The primitive lets operators register
 * the axes + option values, generate the cartesian product for
 * inspection, materialize it into per-SKU rows, and patch each
 * variant's overrides (price, weight, image, inventory).
 *
 * Composes:
 *   - `b.guardUuid`   — every product / variant / axis / option id
 *     passes through the strict UUID profile at the entry point. No
 *     raw caller string ever lands in SQL.
 *   - `b.uuid.v7`     — millisecond-prefixed row id. Lexicographically
 *     sortable → B-tree-locality wins on PKs whose insert pattern is
 *     "newest at the end."
 *   - `b.safeSql`     — UPDATE column allowlist routes through
 *     `safeSql.assertOneOf` + `safeSql.quoteIdentifier` so a future
 *     refactor that introduces a dynamic patch key can't widen the
 *     surface to identifier injection.
 *
 * Surface:
 *   - `defineAxis({ product_id, axis_name, options: [...] })` —
 *     register an axis (e.g. `color`). Position-stable. Refuses if
 *     `axis_name` already exists for the product, refuses empty
 *     options, refuses duplicate option labels (case-insensitive).
 *     Returns `{ id, product_id, axis_name, position, options: [...] }`.
 *   - `generateMatrix(product_id)` — cartesian product of all
 *     defined axes. Returns the variant rows that WOULD be created
 *     without writing them, so the operator can inspect SKU shapes
 *     and decide whether to commit.
 *   - `materializeMatrix(product_id, { sku_prefix, base_price_minor })`
 *     — writes the cartesian product. SKU shape:
 *     `<sku_prefix>-<axis1-opt>-<axis2-opt>-...` with each option
 *     value lowercase-ASCII-slugged. Existing live variants are
 *     re-checked so a re-run after a new axis-option is added only
 *     adds the missing rows.
 *   - `getVariant(variant_id)` — by id; archived rows still resolve
 *     so historic order lines render correctly.
 *   - `variantsForProduct(product_id, { include_archived? })` —
 *     default lists live only; opt-in includes archived rows.
 *   - `findVariant({ product_id, axis_values: { color: 'red', size: 'L' } })`
 *     — exact-match lookup against the axis_values map. Returns
 *     `null` if no live variant matches. Archived rows are excluded
 *     (operators inspect archived state via `getVariant` /
 *     `variantsForProduct({ include_archived: true })`).
 *   - `updateVariant(variant_id, patch)` — partial patch. Allowlist:
 *     `sku`, `price_minor`, `weight_grams`, `image_url`,
 *     `inventory_count`, `archived`. Unknown columns throw — closes
 *     the column-name-injection hole and surfaces typos at write
 *     time.
 *   - `archiveVariant(variant_id)` / `unarchiveVariant(variant_id)` —
 *     toggle `archived_at`.
 *   - `archiveAxisOption({ product_id, axis_name, option_value })` —
 *     soft-archive an option value. Cascades: every live variant
 *     carrying that (axis, option) pair is archived in the same
 *     write. Historic order lines that referenced an archived
 *     variant still resolve via `getVariant`.
 *
 * Storage:
 *   - `product_variant_axes`         (migration `0033_product_variants.sql`)
 *   - `product_variant_axis_options` (same migration)
 *   - `product_variants`             (same migration)
 *
 * @primitive variants
 * @related   b.guardUuid, b.safeSql, b.uuid, catalog
 */

var MAX_AXIS_NAME_LEN     = 64;
var MAX_OPTION_VALUE_LEN  = 64;
var MAX_OPTIONS_PER_AXIS  = 64;
var MAX_AXES_PER_PRODUCT  = 8;
var MAX_SKU_PREFIX_LEN    = 64;
var MAX_SKU_LEN           = 128;
var MAX_IMAGE_URL_LEN     = 2048;
var AXIS_NAME_RE          = /^[a-z][a-z0-9_]{0,63}$/;
var SKU_PREFIX_RE         = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SKU_RE                = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Columns each updateVariant() call may touch. Locked down via
// `b.safeSql.assertOneOf` so a future change introducing a dynamic
// patch key path can't widen the surface to an attacker-controlled
// column name. `archived` is the caller-facing key that maps to the
// `archived_at` timestamp column — handled out-of-band so the
// allowlist matches the storage column name exactly.
var ALLOWED_VARIANT_COLUMNS = Object.freeze([
  "sku", "price_minor", "weight_grams", "image_url", "inventory_count", "archived_at",
]);

var bShop;
function _b() {
  // Lazy-loaded so unit tests can require the module without first
  // initializing the vendored blamejs tree. Matches the pattern used
  // by every other shop primitive.
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ----------------------------------------------------------

function _id(s, label) {
  try {
    return _b().guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("variants: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _axisName(s) {
  if (typeof s !== "string" || !AXIS_NAME_RE.test(s)) {
    throw new TypeError("variants: axis_name must match /^[a-z][a-z0-9_]*$/ (lowercase, " + MAX_AXIS_NAME_LEN + " chars max)");
  }
  return s;
}

function _optionValue(s, label) {
  if (typeof s !== "string" || !s.length || s.length > MAX_OPTION_VALUE_LEN) {
    throw new TypeError("variants: " + label + " must be a non-empty string ≤ " + MAX_OPTION_VALUE_LEN + " chars");
  }
  // Refuse control bytes — the option value renders into HTML on
  // the PDP variant selector AND becomes part of the SKU slug. CR /
  // LF / NUL in either context is a smuggling surface.
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("variants: " + label + " must not contain control bytes");
  }
  return s;
}

function _skuPrefix(s) {
  if (typeof s !== "string" || !SKU_PREFIX_RE.test(s)) {
    throw new TypeError("variants: sku_prefix must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ " + MAX_SKU_PREFIX_LEN + " chars)");
  }
  return s;
}

function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("variants: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ " + MAX_SKU_LEN + " chars)");
  }
  return s;
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("variants: " + label + " must be a non-negative integer");
  }
  return n;
}

function _imageUrl(s) {
  if (s == null || s === "") return "";
  if (typeof s !== "string" || s.length > MAX_IMAGE_URL_LEN) {
    throw new TypeError("variants: image_url must be a string ≤ " + MAX_IMAGE_URL_LEN + " chars");
  }
  // Allow https URLs and protocol-relative storefront paths (e.g.
  // `/assets/...`). Anything else is refused — the image_url lands
  // verbatim into an `<img src="...">` on the PDP, so javascript:,
  // data:, and other exotic schemes are a smuggling surface.
  if (s.charCodeAt(0) === 47 /* "/" */) {
    if (/[\x00-\x1f\x7f]/.test(s) || s.indexOf("..") !== -1) {
      throw new TypeError("variants: image_url path must not contain control bytes or '..'");
    }
    return s;
  }
  try {
    _b().safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("variants: image_url — " + (e && e.message || "must be https:// or a /-rooted path"));
  }
  return s;
}

function _bool(b, label) {
  if (typeof b !== "boolean") {
    throw new TypeError("variants: " + label + " must be a boolean");
  }
  return b;
}

// Slug a single option label into the SKU-safe shape used in the
// compounded `<sku_prefix>-<axis1-opt>-<axis2-opt>-...` string. Lower-
// case ASCII alnum; everything else (whitespace, punctuation, multi-
// byte) collapses to a single `-`. Leading / trailing hyphens are
// trimmed. The full-axis-value SKU stays human-readable (`tshirt-
// navy-large`) without bringing identifier-injection surface to the
// SQL — the SKU column is a parameter, never an identifier.
function _slugOption(s) {
  var out = "";
  var lastWasHyphen = false;
  for (var i = 0; i < s.length; i += 1) {
    var c = s.charCodeAt(i);
    var ch;
    if (c >= 65 && c <= 90)          ch = String.fromCharCode(c + 32);   // A-Z -> a-z
    else if (c >= 97 && c <= 122)    ch = String.fromCharCode(c);        // a-z
    else if (c >= 48 && c <= 57)     ch = String.fromCharCode(c);        // 0-9
    else                              ch = "-";
    if (ch === "-") {
      if (!lastWasHyphen && out.length > 0) {
        out += "-";
        lastWasHyphen = true;
      }
    } else {
      out += ch;
      lastWasHyphen = false;
    }
  }
  // Trim trailing hyphen.
  if (out.length && out.charAt(out.length - 1) === "-") out = out.slice(0, -1);
  if (!out.length) {
    throw new TypeError("variants: option value slugged to empty string (no ASCII alnum characters)");
  }
  return out;
}

// Canonical JSON form for the axis-values map — keys sorted alpha-
// betically so a re-materialize after a column reorder still hits
// the same string. Used both for storage and for `findVariant`
// equality so the comparison is a single string-compare instead of
// a deep-object walk.
function _canonicalAxisValuesJson(map) {
  var keys = Object.keys(map).sort();
  var out = {};
  for (var i = 0; i < keys.length; i += 1) out[keys[i]] = map[keys[i]];
  return JSON.stringify(out);
}

// ---- factory -------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // `catalog` is the catalog primitive instance — used to validate
  // that the `product_id` resolves to a real product before any
  // axis / variant write. The caller passes it through so a future
  // multi-tenant deployment (one catalog instance per shop) can wire
  // the variants instance against the matching catalog without
  // resolving via the global require graph.
  var catalog = opts.catalog || null;

  async function _assertProductExists(productId) {
    if (!catalog) return;     // catalog-free test mode — caller takes responsibility
    var p = await catalog.products.get(productId);
    if (!p) throw new TypeError("variants: product_id — no product matches " + productId);
  }

  async function _axesForProduct(productId) {
    var r = await query(
      "SELECT * FROM product_variant_axes WHERE product_id = ?1 ORDER BY position ASC, created_at ASC",
      [productId],
    );
    return r.rows;
  }

  async function _optionsForAxis(axisId, includeArchived) {
    var sql = includeArchived
      ? "SELECT * FROM product_variant_axis_options WHERE axis_id = ?1 ORDER BY position ASC"
      : "SELECT * FROM product_variant_axis_options WHERE axis_id = ?1 AND archived_at IS NULL ORDER BY position ASC";
    var r = await query(sql, [axisId]);
    return r.rows;
  }

  async function _existingVariantSkus(productId) {
    var r = await query(
      "SELECT sku FROM product_variants WHERE product_id = ?1",
      [productId],
    );
    var set = Object.create(null);
    for (var i = 0; i < r.rows.length; i += 1) set[r.rows[i].sku] = true;
    return set;
  }

  // Internal: build the cartesian product as an array of `{ sku,
  // axis_values }` rows given the already-fetched axes + options.
  // The slug is derived deterministically so the same input always
  // produces the same SKU — re-running materialize is idempotent.
  function _buildMatrix(skuPrefix, axesWithOptions) {
    var rows = [{ axis_values: {}, slugParts: [] }];
    for (var a = 0; a < axesWithOptions.length; a += 1) {
      var axis    = axesWithOptions[a].axis;
      var options = axesWithOptions[a].options;
      var next    = [];
      for (var r = 0; r < rows.length; r += 1) {
        for (var o = 0; o < options.length; o += 1) {
          var optValue = options[o].option_value;
          var copy = {};
          var k;
          for (k in rows[r].axis_values) {
            if (Object.prototype.hasOwnProperty.call(rows[r].axis_values, k)) {
              copy[k] = rows[r].axis_values[k];
            }
          }
          copy[axis.axis_name] = optValue;
          next.push({
            axis_values: copy,
            slugParts:   rows[r].slugParts.concat(_slugOption(optValue)),
          });
        }
      }
      rows = next;
    }
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var sku = skuPrefix + (rows[i].slugParts.length ? "-" + rows[i].slugParts.join("-") : "");
      _sku(sku);  // surfaces an over-long sku_prefix + option combo at generate time
      out.push({
        sku:         sku.toLowerCase(),
        axis_values: rows[i].axis_values,
      });
    }
    return out;
  }

  return {
    // ---- defineAxis -----------------------------------------------------
    //
    // Registers an axis + its option values atomically. The unique
    // index on (product_id, axis_name) refuses the second call for
    // the same name; we pre-flight the check so the operator gets a
    // descriptive TypeError instead of a raw constraint-violation
    // string.
    defineAxis: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("variants.defineAxis: input object required");
      }
      var productId = _id(input.product_id, "product_id");
      var axisName  = _axisName(input.axis_name);
      if (!Array.isArray(input.options) || input.options.length === 0) {
        throw new TypeError("variants.defineAxis: options must be a non-empty array");
      }
      if (input.options.length > MAX_OPTIONS_PER_AXIS) {
        throw new TypeError("variants.defineAxis: options must be ≤ " + MAX_OPTIONS_PER_AXIS + " entries");
      }
      // Validate every option value + refuse case-insensitive
      // duplicates so the operator can't accidentally register `Red`
      // alongside `red` (they'd slug to the same SKU, so we treat
      // them as the same option value).
      var seen = Object.create(null);
      var optionValues = [];
      for (var i = 0; i < input.options.length; i += 1) {
        var v = _optionValue(input.options[i], "options[" + i + "]");
        var key = v.toLowerCase();
        if (seen[key]) {
          throw new TypeError("variants.defineAxis: duplicate option label " + JSON.stringify(input.options[i]) + " (case-insensitive)");
        }
        seen[key] = true;
        optionValues.push(v);
      }
      await _assertProductExists(productId);

      var existingAxes = await _axesForProduct(productId);
      if (existingAxes.length >= MAX_AXES_PER_PRODUCT) {
        throw new TypeError("variants.defineAxis: product already has " + MAX_AXES_PER_PRODUCT + " axes (max)");
      }
      for (var ea = 0; ea < existingAxes.length; ea += 1) {
        if (existingAxes[ea].axis_name === axisName) {
          throw new TypeError("variants.defineAxis: axis_name " + JSON.stringify(axisName) + " already registered for this product");
        }
      }

      var axisId   = _b().uuid.v7();
      var position = existingAxes.length;
      var now      = Date.now();
      await query(
        "INSERT INTO product_variant_axes (id, product_id, axis_name, position, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [axisId, productId, axisName, position, now],
      );
      var insertedOptions = [];
      for (var oi = 0; oi < optionValues.length; oi += 1) {
        var optId = _b().uuid.v7();
        await query(
          "INSERT INTO product_variant_axis_options (id, axis_id, option_value, position, archived_at) " +
          "VALUES (?1, ?2, ?3, ?4, NULL)",
          [optId, axisId, optionValues[oi], oi],
        );
        insertedOptions.push({
          id:           optId,
          axis_id:      axisId,
          option_value: optionValues[oi],
          position:     oi,
          archived_at:  null,
        });
      }
      return {
        id:         axisId,
        product_id: productId,
        axis_name:  axisName,
        position:   position,
        created_at: now,
        options:    insertedOptions,
      };
    },

    // ---- generateMatrix -------------------------------------------------
    //
    // Pure-read: returns the cartesian product as `[ { sku,
    // axis_values } ]` rows without writing. Operators call this to
    // preview SKUs before committing to `materializeMatrix`.
    generateMatrix: async function (productId) {
      var pid = _id(productId, "product_id");
      var axes = await _axesForProduct(pid);
      if (axes.length === 0) {
        throw new TypeError("variants.generateMatrix: no axes registered for product " + pid);
      }
      var axesWithOptions = [];
      for (var i = 0; i < axes.length; i += 1) {
        var opts = await _optionsForAxis(axes[i].id, false);  // live options only
        if (opts.length === 0) {
          throw new TypeError("variants.generateMatrix: axis " + JSON.stringify(axes[i].axis_name) + " has no live options");
        }
        axesWithOptions.push({ axis: axes[i], options: opts });
      }
      // Use a placeholder prefix so the matrix rows can be inspected
      // shape-only — the operator overrides at materialize time.
      return _buildMatrix("preview", axesWithOptions).map(function (row) {
        return {
          sku:         row.sku.replace(/^preview-?/, ""),  // strip placeholder; caller wires their own prefix
          axis_values: row.axis_values,
        };
      });
    },

    // ---- materializeMatrix ----------------------------------------------
    //
    // Writes the cartesian-product rows. Idempotent — a re-run with
    // a freshly-added axis option only inserts the missing rows;
    // existing SKUs are left untouched.
    materializeMatrix: async function (productId, input) {
      var pid = _id(productId, "product_id");
      if (!input || typeof input !== "object") {
        throw new TypeError("variants.materializeMatrix: input object required");
      }
      var skuPrefix = _skuPrefix(input.sku_prefix);
      var basePrice = _nonNegInt(input.base_price_minor, "base_price_minor");

      var axes = await _axesForProduct(pid);
      if (axes.length === 0) {
        throw new TypeError("variants.materializeMatrix: no axes registered for product " + pid);
      }
      var axesWithOptions = [];
      for (var i = 0; i < axes.length; i += 1) {
        var opts = await _optionsForAxis(axes[i].id, false);
        if (opts.length === 0) {
          throw new TypeError("variants.materializeMatrix: axis " + JSON.stringify(axes[i].axis_name) + " has no live options");
        }
        axesWithOptions.push({ axis: axes[i], options: opts });
      }
      var matrix = _buildMatrix(skuPrefix, axesWithOptions);
      var existing = await _existingVariantSkus(pid);

      var inserted = [];
      var skipped  = 0;
      for (var m = 0; m < matrix.length; m += 1) {
        var row = matrix[m];
        if (existing[row.sku]) { skipped += 1; continue; }
        var id   = _b().uuid.v7();
        var now  = Date.now();
        var json = _canonicalAxisValuesJson(row.axis_values);
        await query(
          "INSERT INTO product_variants (id, product_id, sku, axis_values_json, price_minor, " +
          "weight_grams, image_url, inventory_count, archived_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, 0, '', 0, NULL, ?6, ?6)",
          [id, pid, row.sku, json, basePrice, now],
        );
        inserted.push({
          id:               id,
          product_id:       pid,
          sku:              row.sku,
          axis_values:      row.axis_values,
          axis_values_json: json,
          price_minor:      basePrice,
          weight_grams:     0,
          image_url:        "",
          inventory_count:  0,
          archived_at:      null,
          created_at:       now,
          updated_at:       now,
        });
      }
      return { inserted: inserted, skipped: skipped, total: matrix.length };
    },

    // ---- getVariant -----------------------------------------------------
    //
    // By id. Archived rows still resolve so an order line created
    // before the archive can still render its variant.
    getVariant: async function (variantId) {
      var vid = _id(variantId, "variant_id");
      var r = await query("SELECT * FROM product_variants WHERE id = ?1", [vid]);
      var row = r.rows[0] || null;
      if (row) row.axis_values = JSON.parse(row.axis_values_json);
      return row;
    },

    // ---- variantsForProduct ---------------------------------------------
    //
    // Default lists live only. `include_archived: true` returns the
    // full set (admin / inventory views).
    variantsForProduct: async function (productId, listOpts) {
      var pid = _id(productId, "product_id");
      listOpts = listOpts || {};
      var includeArchived = false;
      if (listOpts.include_archived !== undefined) {
        includeArchived = _bool(listOpts.include_archived, "include_archived");
      }
      var sql = includeArchived
        ? "SELECT * FROM product_variants WHERE product_id = ?1 ORDER BY created_at ASC, id ASC"
        : "SELECT * FROM product_variants WHERE product_id = ?1 AND archived_at IS NULL ORDER BY created_at ASC, id ASC";
      var r = await query(sql, [pid]);
      return r.rows.map(function (row) {
        row.axis_values = JSON.parse(row.axis_values_json);
        return row;
      });
    },

    // ---- findVariant ----------------------------------------------------
    //
    // Exact-match by (product_id, axis_values). The axis_values_json
    // column is stored canonical (keys sorted), so the lookup
    // canonicalises the input the same way and matches as a single
    // string compare. Archived variants are excluded — operators
    // looking for an archived row use `getVariant` or
    // `variantsForProduct({ include_archived: true })`.
    findVariant: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("variants.findVariant: input object required");
      }
      var pid = _id(input.product_id, "product_id");
      if (!input.axis_values || typeof input.axis_values !== "object" || Array.isArray(input.axis_values)) {
        throw new TypeError("variants.findVariant: axis_values must be a plain object (axis_name -> option_value)");
      }
      // Validate every key + value before hashing them into the
      // canonical JSON — refuses control bytes, oversized values,
      // and non-axis-name-shaped keys.
      var keys = Object.keys(input.axis_values);
      if (keys.length === 0) {
        throw new TypeError("variants.findVariant: axis_values must have at least one entry");
      }
      for (var i = 0; i < keys.length; i += 1) {
        _axisName(keys[i]);
        _optionValue(input.axis_values[keys[i]], "axis_values[" + JSON.stringify(keys[i]) + "]");
      }
      var canonical = _canonicalAxisValuesJson(input.axis_values);
      var r = await query(
        "SELECT * FROM product_variants WHERE product_id = ?1 AND axis_values_json = ?2 " +
        "AND archived_at IS NULL LIMIT 1",
        [pid, canonical],
      );
      var row = r.rows[0] || null;
      if (row) row.axis_values = JSON.parse(row.axis_values_json);
      return row;
    },

    // ---- updateVariant --------------------------------------------------
    //
    // Partial patch. The allowlist routes through `b.safeSql` so an
    // unknown column key throws — the column is never composed into
    // SQL from a caller-supplied identifier.
    updateVariant: async function (variantId, patch) {
      var vid = _id(variantId, "variant_id");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("variants.updateVariant: patch object required");
      }
      // Refuse any key that isn't on the caller-facing allowlist
      // BEFORE composing SQL. The caller-facing key set is
      // {sku, price_minor, weight_grams, image_url, inventory_count,
      // archived} — `archived` maps to `archived_at` (timestamp)
      // out-of-band so the storage column stays the timestamp.
      var ALLOWED_PATCH_KEYS = ["sku", "price_minor", "weight_grams", "image_url", "inventory_count", "archived"];
      var patchKeys = Object.keys(patch);
      for (var pk = 0; pk < patchKeys.length; pk += 1) {
        if (ALLOWED_PATCH_KEYS.indexOf(patchKeys[pk]) === -1) {
          throw new TypeError("variants.updateVariant: unknown patch key " + JSON.stringify(patchKeys[pk]) +
            " (allowed: " + ALLOWED_PATCH_KEYS.join(", ") + ")");
        }
      }
      var sets   = [];
      var params = [];
      var i = 1;
      function _addSet(col, val) {
        _b().safeSql.assertOneOf(col, ALLOWED_VARIANT_COLUMNS);
        sets.push(_b().safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (i++));
        params.push(val);
      }
      if (patch.sku !== undefined) {
        _sku(patch.sku);
        _addSet("sku", patch.sku);
      }
      if (patch.price_minor !== undefined) {
        _nonNegInt(patch.price_minor, "price_minor");
        _addSet("price_minor", patch.price_minor);
      }
      if (patch.weight_grams !== undefined) {
        _nonNegInt(patch.weight_grams, "weight_grams");
        _addSet("weight_grams", patch.weight_grams);
      }
      if (patch.image_url !== undefined) {
        _addSet("image_url", _imageUrl(patch.image_url));
      }
      if (patch.inventory_count !== undefined) {
        _nonNegInt(patch.inventory_count, "inventory_count");
        _addSet("inventory_count", patch.inventory_count);
      }
      if (patch.archived !== undefined) {
        var archived = _bool(patch.archived, "archived");
        _addSet("archived_at", archived ? Date.now() : null);
      }
      if (sets.length === 0) {
        throw new TypeError("variants.updateVariant: patch contained no updatable fields");
      }
      var ts = Date.now();
      sets.push("updated_at = ?" + (i++));
      params.push(ts);
      params.push(vid);
      var r = await query(
        "UPDATE product_variants SET " + sets.join(", ") + " WHERE id = ?" + i,
        params,
      );
      if (r.rowCount === 0) return null;
      return await this.getVariant(vid);
    },

    // ---- archiveVariant / unarchiveVariant ------------------------------
    archiveVariant: async function (variantId) {
      var vid = _id(variantId, "variant_id");
      var ts = Date.now();
      var r = await query(
        "UPDATE product_variants SET archived_at = ?1, updated_at = ?1 WHERE id = ?2 AND archived_at IS NULL",
        [ts, vid],
      );
      if (r.rowCount === 0) {
        // Could be missing or already archived — disambiguate so the
        // caller gets a meaningful answer.
        var existing = await query("SELECT id FROM product_variants WHERE id = ?1", [vid]);
        if (existing.rows.length === 0) return null;
      }
      return await this.getVariant(vid);
    },

    unarchiveVariant: async function (variantId) {
      var vid = _id(variantId, "variant_id");
      var ts = Date.now();
      await query(
        "UPDATE product_variants SET archived_at = NULL, updated_at = ?1 WHERE id = ?2",
        [ts, vid],
      );
      return await this.getVariant(vid);
    },

    // ---- archiveAxisOption ----------------------------------------------
    //
    // Soft-archives the (axis_name, option_value) pair so the
    // storefront PDP can't render it as a selectable option, then
    // cascades the archive to every live variant that carries that
    // pair in its axis_values map.
    archiveAxisOption: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("variants.archiveAxisOption: input object required");
      }
      var pid       = _id(input.product_id, "product_id");
      var axisName  = _axisName(input.axis_name);
      var optValue  = _optionValue(input.option_value, "option_value");

      // Resolve the axis + option rows.
      var axisRow = (await query(
        "SELECT id FROM product_variant_axes WHERE product_id = ?1 AND axis_name = ?2",
        [pid, axisName],
      )).rows[0];
      if (!axisRow) {
        throw new TypeError("variants.archiveAxisOption: no axis " + JSON.stringify(axisName) + " for product " + pid);
      }
      var optRow = (await query(
        "SELECT id, archived_at FROM product_variant_axis_options WHERE axis_id = ?1 AND option_value = ?2",
        [axisRow.id, optValue],
      )).rows[0];
      if (!optRow) {
        throw new TypeError("variants.archiveAxisOption: no option " + JSON.stringify(optValue) + " on axis " + JSON.stringify(axisName));
      }
      var ts = Date.now();
      await query(
        "UPDATE product_variant_axis_options SET archived_at = ?1 WHERE id = ?2 AND archived_at IS NULL",
        [ts, optRow.id],
      );

      // Cascade: archive every live variant whose axis_values_json
      // carries this (axis_name, option_value). We pull the candidate
      // set in a single query, then walk in JS — the table is small
      // per product (max axes × max options = 8 × 64 = 512 rows),
      // and the JSON-match is more reliable than a LIKE pattern
      // against a textual JSON encoding.
      var liveRows = (await query(
        "SELECT id, axis_values_json FROM product_variants WHERE product_id = ?1 AND archived_at IS NULL",
        [pid],
      )).rows;
      var cascadedIds = [];
      for (var i = 0; i < liveRows.length; i += 1) {
        var map;
        try { map = JSON.parse(liveRows[i].axis_values_json); }
        catch (_e) { continue; }
        if (map && map[axisName] === optValue) {
          cascadedIds.push(liveRows[i].id);
        }
      }
      for (var ci = 0; ci < cascadedIds.length; ci += 1) {
        await query(
          "UPDATE product_variants SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
          [ts, cascadedIds[ci]],
        );
      }
      return {
        axis_id:      axisRow.id,
        option_id:    optRow.id,
        archived_at:  ts,
        cascaded_variant_ids: cascadedIds,
      };
    },
  };
}

module.exports = {
  create: create,
};
