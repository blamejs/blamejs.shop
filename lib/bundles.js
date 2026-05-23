"use strict";
/**
 * @module shop.bundles
 * @title  Bundles primitive — virtual composite SKUs (kit products)
 *
 * @intro
 *   A bundle is a virtual SKU that resolves to N child SKUs with
 *   integer quantity multipliers. The storefront sells the bundle as
 *   a single line item; the cart-line resolution layer composes
 *   `bundles.expand()` to convert that line into the underlying
 *   component lines so inventory deduction, fulfillment picking and
 *   tax/shipping see the real components.
 *
 *   Composition rules:
 *
 *     - Component SKUs MUST exist in the catalog at define time. The
 *       primitive composes `catalog.variants.bySku(sku)` to verify;
 *       an unknown SKU throws synchronously.
 *
 *     - A component MAY itself be a bundle. Nesting is capped at two
 *       levels — a top-level bundle whose components are themselves
 *       bundles is allowed; a three-level chain (bundle → bundle →
 *       bundle) is refused at `expand()` time.
 *
 *     - Cyclic references are refused at `defineBundle()`. The
 *       primitive walks every component (and their components) up to
 *       the nesting cap, looking for a back-edge to the bundle being
 *       defined.
 *
 *   Pricing:
 *
 *     `priceBundle({ bundle_sku, pricing })` sums every leaf
 *     component's `pricing.priceFor(sku) → { amount_minor, currency }`
 *     (multiplied by its effective quantity), optionally applying the
 *     stored `bundle_discount_bps` override. The caller is
 *     responsible for currency consistency across components; mixed
 *     currencies throw rather than silently coercing.
 *
 *   Deletion:
 *
 *     `deleteBundle()` refuses while any active cart references the
 *     bundle. Reactivation of an "abandoned" cart that referenced the
 *     bundle is the operator's problem to resolve; the primitive
 *     only blocks on rows currently held by `carts.status = 'active'`.
 *
 *     Subscriptions in this codebase bind to a variant_id (not an
 *     SKU), so a subscription cannot directly hold a bundle today.
 *     The deletion check stays scoped to cart_lines; a future
 *     subscription-by-sku surface composes the same check by passing
 *     an `extraReferenceCheck` callback to the factory.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// SKU shape is shared with the catalog primitive — same alphabet, same
// length cap. Component lookup goes through the catalog, so the two
// validators must stay in lockstep; if catalog.SKU_RE ever changes,
// this regex changes with it. The two are pinned by tests so drift
// surfaces immediately.
var SKU_RE        = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var MAX_TITLE_LEN = 500;
var MAX_LIMIT     = 200;
var MAX_NESTING_DEPTH = 2;

// Mutable columns for updateBundle — `bundle_sku` is the natural key
// and is immutable post-create (operators delete + redefine to rename
// a bundle SKU). `created_at` is also immutable.
var ALLOWED_BUNDLE_COLUMNS = Object.freeze(["title", "bundle_discount_bps"]);

var BUNDLE_ORDER_KEY = ["updated_at:desc", "bundle_sku:desc"];

// ---- validators ----------------------------------------------------------

function _sku(s, label) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("bundles: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, <= 128 chars)");
  }
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("bundles: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("bundles: " + label + " must be a positive integer");
  }
}

function _discountBps(n) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0 || n > 10000) {
    throw new TypeError("bundles: bundle_discount_bps must be an integer in [0, 10000] (basis points) or null");
  }
  return n;
}

function _now() { return Date.now(); }

// ---- factory -------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  var catalog = opts.catalog;
  if (!catalog || !catalog.variants || typeof catalog.variants.bySku !== "function") {
    throw new TypeError("bundles.create: opts.catalog must expose variants.bySku(sku)");
  }
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("bundles.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "bundles-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Optional caller-supplied reference check fires alongside the
  // built-in active-cart check inside deleteBundle. Returns truthy to
  // veto the delete (signature: `async (bundle_sku) => bool`). Lets a
  // downstream subscription-by-sku surface compose its own veto
  // without a schema change here.
  var extraReferenceCheck = typeof opts.extraReferenceCheck === "function"
    ? opts.extraReferenceCheck
    : null;

  // ---- internal helpers --------------------------------------------------

  async function _bundleRow(bundleSku) {
    var r = await query("SELECT * FROM bundles WHERE bundle_sku = ?1", [bundleSku]);
    return r.rows[0] || null;
  }

  async function _componentRows(bundleSku) {
    var r = await query(
      "SELECT bundle_sku, sku, quantity, sort_order FROM bundle_components " +
      "WHERE bundle_sku = ?1 ORDER BY sort_order ASC, sku ASC",
      [bundleSku],
    );
    return r.rows;
  }

  // Cycle + missing-SKU walker. Used at defineBundle to verify that
  // none of the proposed components (or their transitive components,
  // up to MAX_NESTING_DEPTH) loops back to `rootSku`, and that every
  // referenced SKU exists in the catalog OR resolves to another
  // already-stored bundle (which itself was verified at its own
  // define time).
  //
  // The walker is bounded: it returns control after MAX_NESTING_DEPTH
  // levels regardless of whether the leaves are bundles or variants.
  // expand() applies the same cap with the matching error message.
  async function _verifyComponentsAcyclic(rootSku, components) {
    // Components are already shape-validated by the caller.
    for (var i = 0; i < components.length; i += 1) {
      var sku = components[i].sku;
      if (sku === rootSku) {
        throw new TypeError("bundles.defineBundle: cyclic reference — component sku " + JSON.stringify(sku) + " equals bundle_sku");
      }
    }
    // For each component, classify as bundle vs variant and walk
    // bundle children one more level deep. A component that itself
    // points to bundles forms a 2-level structure; we must look at
    // those grandchildren to catch a back-edge to rootSku.
    for (var j = 0; j < components.length; j += 1) {
      var csku = components[j].sku;
      var childBundle = await _bundleRow(csku);
      if (childBundle) {
        var grand = await _componentRows(csku);
        for (var k = 0; k < grand.length; k += 1) {
          if (grand[k].sku === rootSku) {
            throw new TypeError("bundles.defineBundle: cyclic reference — component " + JSON.stringify(csku) +
                                " contains " + JSON.stringify(rootSku));
          }
          // Walking further would exceed MAX_NESTING_DEPTH; the
          // grandchild MUST be a leaf variant (not a third-level
          // bundle) for the structure to be expandable. Verify the
          // leaf is a real catalog SKU; if it's another bundle, we
          // reject here because expand() would refuse it anyway.
          var grandIsBundle = await _bundleRow(grand[k].sku);
          if (grandIsBundle) {
            throw new TypeError("bundles.defineBundle: nesting exceeds " + MAX_NESTING_DEPTH +
                                " levels — component " + JSON.stringify(csku) + " contains bundle " + JSON.stringify(grand[k].sku));
          }
          var leafVariant = await catalog.variants.bySku(grand[k].sku);
          if (!leafVariant) {
            throw new TypeError("bundles.defineBundle: nested component sku " + JSON.stringify(grand[k].sku) +
                                " (in bundle " + JSON.stringify(csku) + ") not found in catalog");
          }
        }
        continue;
      }
      // Not a bundle — must be a catalog variant.
      var variant = await catalog.variants.bySku(csku);
      if (!variant) {
        throw new TypeError("bundles.defineBundle: component sku " + JSON.stringify(csku) + " not found in catalog");
      }
    }
  }

  // ---- defineBundle ------------------------------------------------------

  async function defineBundle(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("bundles.defineBundle: input object required");
    }
    _sku(input.bundle_sku, "bundle_sku");
    _title(input.title);
    if (!Array.isArray(input.components) || input.components.length === 0) {
      throw new TypeError("bundles.defineBundle: components must be a non-empty array");
    }
    var discountBps = _discountBps(input.bundle_discount_bps == null ? null : input.bundle_discount_bps);

    // Validate every component shape before any DB write.
    var seen = Object.create(null);
    var components = [];
    for (var i = 0; i < input.components.length; i += 1) {
      var c = input.components[i];
      if (!c || typeof c !== "object") {
        throw new TypeError("bundles.defineBundle: components[" + i + "] must be an object");
      }
      _sku(c.sku, "components[" + i + "].sku");
      _positiveInt(c.quantity, "components[" + i + "].quantity");
      if (seen[c.sku]) {
        throw new TypeError("bundles.defineBundle: duplicate component sku " + JSON.stringify(c.sku));
      }
      seen[c.sku] = true;
      components.push({ sku: c.sku, quantity: c.quantity });
    }

    // Refuse if the bundle_sku collides with an existing catalog
    // variant — bundle SKUs and variant SKUs share a namespace and
    // an ambiguous lookup would silently route the wrong row.
    var collision = await catalog.variants.bySku(input.bundle_sku);
    if (collision) {
      throw new TypeError("bundles.defineBundle: bundle_sku " + JSON.stringify(input.bundle_sku) +
                          " collides with an existing catalog variant SKU");
    }

    // Refuse on existing bundle_sku.
    var existing = await _bundleRow(input.bundle_sku);
    if (existing) {
      throw new TypeError("bundles.defineBundle: bundle_sku " + JSON.stringify(input.bundle_sku) + " already exists");
    }

    // Verify every component exists in catalog (or resolves to a
    // bundle whose own components live in catalog), and that no
    // transitive component loops back to bundle_sku. Pure read-only
    // — runs before any insert.
    await _verifyComponentsAcyclic(input.bundle_sku, components);

    var ts = _now();
    await query(
      "INSERT INTO bundles (bundle_sku, title, bundle_discount_bps, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?4)",
      [input.bundle_sku, input.title, discountBps, ts],
    );
    for (var k = 0; k < components.length; k += 1) {
      await query(
        "INSERT INTO bundle_components (bundle_sku, sku, quantity, sort_order) VALUES (?1, ?2, ?3, ?4)",
        [input.bundle_sku, components[k].sku, components[k].quantity, k],
      );
    }
    return await getBundle(input.bundle_sku);
  }

  // ---- getBundle ---------------------------------------------------------

  async function getBundle(bundleSku) {
    _sku(bundleSku, "bundle_sku");
    var row = await _bundleRow(bundleSku);
    if (!row) return null;
    var comps = await _componentRows(bundleSku);
    return {
      bundle_sku:          row.bundle_sku,
      title:               row.title,
      bundle_discount_bps: row.bundle_discount_bps,
      created_at:          row.created_at,
      updated_at:          row.updated_at,
      components:          comps.map(function (c) {
        return { sku: c.sku, quantity: c.quantity, sort_order: c.sort_order };
      }),
    };
  }

  // ---- listBundles -------------------------------------------------------

  async function listBundles(input) {
    input = input || {};
    var limit = input.limit == null ? 50 : input.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      throw new TypeError("bundles.listBundles: limit must be 1..." + MAX_LIMIT);
    }
    var cursorVals = null;
    if (input.cursor != null) {
      if (typeof input.cursor !== "string") {
        throw new TypeError("bundles.listBundles: cursor must be an opaque string or null");
      }
      try {
        var state = _b().pagination.decodeCursor(input.cursor, cursorSecret);
        if (JSON.stringify(state.orderKey) !== JSON.stringify(BUNDLE_ORDER_KEY)) {
          throw new TypeError("bundles.listBundles: cursor orderKey mismatch");
        }
        cursorVals = state.vals;
      } catch (e) {
        if (e instanceof TypeError) throw e;
        throw new TypeError("bundles.listBundles: cursor — " + (e && e.message || "malformed"));
      }
    }
    var sql, params;
    if (cursorVals) {
      sql = "SELECT * FROM bundles WHERE updated_at < ?1 OR (updated_at = ?1 AND bundle_sku < ?2) " +
            "ORDER BY updated_at DESC, bundle_sku DESC LIMIT ?3";
      params = [cursorVals[0], cursorVals[1], limit];
    } else {
      sql = "SELECT * FROM bundles ORDER BY updated_at DESC, bundle_sku DESC LIMIT ?1";
      params = [limit];
    }
    var r = await query(sql, params);
    var last = r.rows[r.rows.length - 1];
    var next = null;
    if (last && r.rows.length === limit) {
      next = _b().pagination.encodeCursor({
        orderKey: BUNDLE_ORDER_KEY,
        vals:     [last.updated_at, last.bundle_sku],
        forward:  true,
      }, cursorSecret);
    }
    return { rows: r.rows, next_cursor: next };
  }

  // ---- expand ------------------------------------------------------------

  // Flatten a bundle into its leaf components with multipliers applied.
  // Handles nested bundles two levels deep — a leaf that is itself a
  // bundle gets expanded once more; a third-level bundle throws.
  //
  // Returns `[{ sku, quantity }, ...]` where each row represents the
  // total demanded quantity for that leaf SKU across the entire
  // expansion. If two components (directly or via nesting) reference
  // the same leaf SKU, their quantities are summed into one row.
  async function expand(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("bundles.expand: input object required");
    }
    _sku(input.bundle_sku, "bundle_sku");
    _positiveInt(input.quantity, "quantity");

    var row = await _bundleRow(input.bundle_sku);
    if (!row) {
      throw new TypeError("bundles.expand: bundle_sku " + JSON.stringify(input.bundle_sku) + " not found");
    }
    var comps = await _componentRows(input.bundle_sku);

    var totals = Object.create(null);
    function _add(sku, qty) {
      totals[sku] = (totals[sku] || 0) + qty;
    }

    for (var i = 0; i < comps.length; i += 1) {
      var c = comps[i];
      var demanded = c.quantity * input.quantity;
      var childBundle = await _bundleRow(c.sku);
      if (childBundle) {
        var childComps = await _componentRows(c.sku);
        for (var j = 0; j < childComps.length; j += 1) {
          var gc = childComps[j];
          var grandIsBundle = await _bundleRow(gc.sku);
          if (grandIsBundle) {
            throw new TypeError("bundles.expand: nesting exceeds " + MAX_NESTING_DEPTH +
                                " levels — " + JSON.stringify(c.sku) + " contains bundle " + JSON.stringify(gc.sku));
          }
          _add(gc.sku, gc.quantity * demanded);
        }
      } else {
        _add(c.sku, demanded);
      }
    }

    var out = [];
    var keys = Object.keys(totals).sort();
    for (var k = 0; k < keys.length; k += 1) {
      out.push({ sku: keys[k], quantity: totals[keys[k]] });
    }
    return out;
  }

  // ---- priceBundle -------------------------------------------------------

  async function priceBundle(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("bundles.priceBundle: input object required");
    }
    _sku(input.bundle_sku, "bundle_sku");
    var pricing = input.pricing;
    if (!pricing || typeof pricing.priceFor !== "function") {
      throw new TypeError("bundles.priceBundle: pricing.priceFor(sku) required");
    }
    var row = await _bundleRow(input.bundle_sku);
    if (!row) {
      throw new TypeError("bundles.priceBundle: bundle_sku " + JSON.stringify(input.bundle_sku) + " not found");
    }

    // Expand to leaf quantities at multiplier=1 so the per-leaf price
    // lookup happens once. The bundle is priced at its own "unit"
    // (one bundle); cart math multiplies that by the line qty
    // downstream.
    var leaves = await expand({ bundle_sku: input.bundle_sku, quantity: 1 });

    var currency = null;
    var listTotal = 0;
    for (var i = 0; i < leaves.length; i += 1) {
      var leaf = leaves[i];
      var priced = await pricing.priceFor(leaf.sku);
      if (!priced || typeof priced !== "object") {
        throw new TypeError("bundles.priceBundle: pricing.priceFor(" + JSON.stringify(leaf.sku) + ") returned no row");
      }
      if (!Number.isInteger(priced.amount_minor) || priced.amount_minor < 0) {
        throw new TypeError("bundles.priceBundle: pricing.priceFor(" + JSON.stringify(leaf.sku) + ").amount_minor must be a non-negative integer");
      }
      if (typeof priced.currency !== "string" || !priced.currency.length) {
        throw new TypeError("bundles.priceBundle: pricing.priceFor(" + JSON.stringify(leaf.sku) + ").currency must be a non-empty string");
      }
      if (currency === null) {
        currency = priced.currency;
      } else if (priced.currency !== currency) {
        throw new TypeError("bundles.priceBundle: mixed currencies — " + JSON.stringify(currency) +
                            " vs " + JSON.stringify(priced.currency) + " on sku " + JSON.stringify(leaf.sku));
      }
      listTotal += priced.amount_minor * leaf.quantity;
    }

    var discountBps = row.bundle_discount_bps;
    var discountMinor = 0;
    if (discountBps != null && discountBps > 0) {
      // Integer floor — basis points are 1/100 of a percent (10000 =
      // 100%). The floor keeps the customer from paying a fractional
      // cent and matches the rounding convention the pricing
      // primitive uses for line totals.
      discountMinor = Math.floor((listTotal * discountBps) / 10000);
    }
    var grandTotal = listTotal - discountMinor;
    return {
      bundle_sku:          input.bundle_sku,
      currency:            currency,
      list_total_minor:    listTotal,
      bundle_discount_bps: discountBps,
      discount_minor:      discountMinor,
      amount_minor:        grandTotal,
    };
  }

  // ---- updateBundle ------------------------------------------------------

  async function updateBundle(bundleSku, patch) {
    _sku(bundleSku, "bundle_sku");
    if (!patch || typeof patch !== "object") {
      throw new TypeError("bundles.updateBundle: patch object required");
    }
    var sets = [];
    var params = [];
    var idx = 1;
    function _addSet(col, val) {
      // Allow-list defense even though the column name is a literal —
      // a future refactor that introduces a dynamic patch key path
      // can't widen the surface to an attacker-controlled column.
      _b().safeSql.assertOneOf(col, ALLOWED_BUNDLE_COLUMNS);
      sets.push(_b().safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (idx++));
      params.push(val);
    }
    if (patch.title !== undefined) {
      _title(patch.title);
      _addSet("title", patch.title);
    }
    if (patch.bundle_discount_bps !== undefined) {
      _addSet("bundle_discount_bps", _discountBps(patch.bundle_discount_bps));
    }
    if (patch.components !== undefined) {
      // Component rewrites are a structural change: validate every
      // proposed component, re-run the cycle walker against the
      // existing bundle_sku, then atomically (best-effort under D1's
      // no-cross-statement-transaction model) delete + reinsert.
      if (!Array.isArray(patch.components) || patch.components.length === 0) {
        throw new TypeError("bundles.updateBundle: components must be a non-empty array");
      }
      var seen = Object.create(null);
      var newComponents = [];
      for (var i = 0; i < patch.components.length; i += 1) {
        var pc = patch.components[i];
        if (!pc || typeof pc !== "object") {
          throw new TypeError("bundles.updateBundle: components[" + i + "] must be an object");
        }
        _sku(pc.sku, "components[" + i + "].sku");
        _positiveInt(pc.quantity, "components[" + i + "].quantity");
        if (seen[pc.sku]) {
          throw new TypeError("bundles.updateBundle: duplicate component sku " + JSON.stringify(pc.sku));
        }
        seen[pc.sku] = true;
        newComponents.push({ sku: pc.sku, quantity: pc.quantity });
      }
      var existing = await _bundleRow(bundleSku);
      if (!existing) return null;
      await _verifyComponentsAcyclic(bundleSku, newComponents);
      await query("DELETE FROM bundle_components WHERE bundle_sku = ?1", [bundleSku]);
      for (var m = 0; m < newComponents.length; m += 1) {
        await query(
          "INSERT INTO bundle_components (bundle_sku, sku, quantity, sort_order) VALUES (?1, ?2, ?3, ?4)",
          [bundleSku, newComponents[m].sku, newComponents[m].quantity, m],
        );
      }
    }
    if (sets.length === 0 && patch.components === undefined) {
      throw new TypeError("bundles.updateBundle: patch contained no updatable fields");
    }
    var ts = _now();
    if (sets.length > 0) {
      sets.push("updated_at = ?" + (idx++));
      params.push(ts);
      params.push(bundleSku);
      var r = await query(
        "UPDATE bundles SET " + sets.join(", ") + " WHERE bundle_sku = ?" + idx,
        params,
      );
      if (r.rowCount === 0 && patch.components === undefined) return null;
    } else {
      // Components-only patch — still bump updated_at so cursors order
      // recent edits correctly.
      await query("UPDATE bundles SET updated_at = ?1 WHERE bundle_sku = ?2", [ts, bundleSku]);
    }
    return await getBundle(bundleSku);
  }

  // ---- deleteBundle ------------------------------------------------------

  async function deleteBundle(bundleSku) {
    _sku(bundleSku, "bundle_sku");
    // Active-cart reference check. `carts.status = 'active'` is the
    // only state that holds a live customer claim on the bundle;
    // converted/abandoned carts are historical and don't block
    // deletion (the order primitive owns post-conversion state).
    var refs = await query(
      "SELECT COUNT(*) AS n FROM cart_lines cl " +
      "JOIN carts c ON c.id = cl.cart_id " +
      "WHERE cl.sku = ?1 AND c.status = 'active'",
      [bundleSku],
    );
    var refCount = refs.rows[0] && (refs.rows[0].n || refs.rows[0].N);
    if (refCount && refCount > 0) {
      throw new TypeError("bundles.deleteBundle: bundle_sku " + JSON.stringify(bundleSku) +
                          " is referenced by " + refCount + " active cart line(s) — clear those carts before deleting");
    }
    if (extraReferenceCheck) {
      var extra = await extraReferenceCheck(bundleSku);
      if (extra) {
        throw new TypeError("bundles.deleteBundle: bundle_sku " + JSON.stringify(bundleSku) +
                            " is referenced by an external subscription / order surface");
      }
    }
    // FK ON DELETE CASCADE drops the bundle_components rows.
    var r = await query("DELETE FROM bundles WHERE bundle_sku = ?1", [bundleSku]);
    return r.rowCount > 0;
  }

  return {
    defineBundle: defineBundle,
    getBundle:    getBundle,
    listBundles:  listBundles,
    expand:       expand,
    priceBundle:  priceBundle,
    updateBundle: updateBundle,
    deleteBundle: deleteBundle,
  };
}

module.exports = {
  create:                create,
  MAX_NESTING_DEPTH:     MAX_NESTING_DEPTH,
  ALLOWED_BUNDLE_COLUMNS: ALLOWED_BUNDLE_COLUMNS,
};
