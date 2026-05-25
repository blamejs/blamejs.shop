"use strict";
/**
 * @module shop.quantityDiscounts
 * @title  Quantity-discount tiers — automatic per-line price breaks
 *
 * @intro
 *   A quantity discount is an automatic, code-less price reduction
 *   that activates when a cart line crosses a quantity threshold.
 *   "Buy 5 of SKU X for 10% off, buy 10 for 20% off" is the
 *   canonical shape. Distinct from coupons (per-cart codes typed by
 *   the shopper) and from bundle pricing (a single composite SKU's
 *   price): a quantity discount attaches to a SCOPE (one SKU, one
 *   product, a vendor, a category, a collection slug, or
 *   "everything") and a SCHEDULE of (min_quantity, discount_kind,
 *   value) rules. The pricing primitive consults this surface during
 *   cart-line resolution and applies the best (lowest final unit
 *   price) matching rule.
 *
 *   Scope specificity ordering:
 *
 *     sku > product > collection_slug > vendor > category > global
 *
 *   Multiple non-exclusive tier sets across different scopes can
 *   stack — applyToLine walks every applicable rule and picks the
 *   single best one (the one that yields the lowest discounted unit
 *   price). An `exclusive` tier set short-circuits the walk: when an
 *   exclusive set's best rule applies, no other tier-set rule may
 *   compete.
 *
 *   Discount kinds:
 *
 *     percent_off          — value is basis points (0..10000)
 *     amount_off_each      — value is minor units off each unit
 *     amount_off_total     — value is minor units off the line total
 *     fixed_each_price     — value is the new unit price in minor
 *                            units (overrides the catalog price)
 *
 *   The discounted unit price is clamped at 0 — a schedule that
 *   would push the unit below zero collapses to "free", never
 *   negative. The pricing primitive composes this surface; it does
 *   not formatting / locale / tax math (those land elsewhere).
 *
 *   Composition with `b.money`:
 *
 *     Every per-unit / per-line minor-unit multiplication routes
 *     through `b.money.fromMinorUnits(...).multiply(...)` so the
 *     half-even rounding stays consistent with the framework's
 *     Money class. The primitive returns integer minor units to the
 *     caller (the cart / pricing surface that already speaks minor
 *     units); the BigInt-Money round-trip is an internal detail.
 */

var b = require("./vendor/blamejs");

// ---- constants -----------------------------------------------------------

var VALID_SCOPES = Object.freeze([
  "sku", "product", "collection_slug", "vendor", "category", "global",
]);

// Ordering reads sku-first (most specific) -> global (least). The
// applyToLine walk consults the rule list in this order so the
// "best" rule across stacked tier sets is deterministically the
// most-specific scope's rule when multiple kinds produce the same
// final price.
var SCOPE_SPECIFICITY = Object.freeze({
  sku:              6,
  product:          5,
  collection_slug:  4,
  vendor:           3,
  category:         2,
  global:           1,
});

var VALID_KINDS = Object.freeze([
  "percent_off",
  "amount_off_each",
  "amount_off_total",
  "fixed_each_price",
]);

// Mutable columns for update() — `scope` / `scope_id` are the
// natural key for lookups and immutable post-create (operators
// archive + redefine to rebind a schedule). `created_at` is
// immutable.
var ALLOWED_SET_COLUMNS = Object.freeze(["exclusive"]);

var MAX_TIERS_PER_SET = 50;
var MAX_LIMIT         = 200;

// Generous upper cap on scope_id (SKU max is 128 in catalog, slugs
// and vendor names tend to fit well under 256). We keep the cap
// loose at the primitive boundary; the catalog primitive owns
// stricter shape rules for its own ids.
var MAX_SCOPE_ID_LEN  = 256;

var SCOPE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9 ._\-:/]{0,255}$/;

// ---- validators ----------------------------------------------------------

function _assertScope(s) {
  if (typeof s !== "string" || VALID_SCOPES.indexOf(s) === -1) {
    throw new TypeError("quantityDiscounts: scope must be one of " +
                        JSON.stringify(VALID_SCOPES) + ", got " + JSON.stringify(s));
  }
}

function _assertScopeIdShape(scope, scopeId) {
  if (scope === "global") {
    if (scopeId != null) {
      throw new TypeError("quantityDiscounts: scope_id must be null when scope = 'global'");
    }
    return;
  }
  if (typeof scopeId !== "string" || !scopeId.length || scopeId.length > MAX_SCOPE_ID_LEN || !SCOPE_ID_RE.test(scopeId)) {
    throw new TypeError("quantityDiscounts: scope_id must be a non-empty string (<= " + MAX_SCOPE_ID_LEN +
                        " chars, alnum + ' ._-:/') when scope <> 'global'");
  }
}

function _assertKind(k) {
  if (typeof k !== "string" || VALID_KINDS.indexOf(k) === -1) {
    throw new TypeError("quantityDiscounts: discount_kind must be one of " +
                        JSON.stringify(VALID_KINDS) + ", got " + JSON.stringify(k));
  }
}

function _assertPositiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("quantityDiscounts: " + label + " must be a positive integer, got " + JSON.stringify(n));
  }
}

function _assertNonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("quantityDiscounts: " + label + " must be a non-negative integer, got " + JSON.stringify(n));
  }
}

// Per-kind upper bound on `value`. The CHECK in SQL only enforces
// value >= 0; the kind-specific cap belongs at the app layer where
// the error message carries the domain meaning.
function _assertValueForKind(kind, value) {
  _assertNonNegInt(value, "value");
  if (kind === "percent_off" && value > 10000) {
    throw new TypeError("quantityDiscounts: percent_off value must be 0..10000 basis points (100% = 10000), got " + value);
  }
}

function _now() { return Date.now(); }

// ---- factory -------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var catalog = opts.catalog;
  if (!catalog || !catalog.variants || typeof catalog.variants.bySku !== "function") {
    throw new TypeError("quantityDiscounts.create: opts.catalog must expose variants.bySku(sku)");
  }

  // ---- internal helpers ------------------------------------------------

  async function _setRow(id) {
    var r = await query("SELECT * FROM qd_tier_sets WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _tierRowsForSet(setId) {
    var r = await query(
      "SELECT id, tier_set_id, min_quantity, discount_kind, value, sort_order " +
      "FROM qd_tiers WHERE tier_set_id = ?1 ORDER BY sort_order ASC, min_quantity ASC",
      [setId],
    );
    return r.rows;
  }

  function _shapeTierSet(setRow, tierRows) {
    return {
      id:          setRow.id,
      scope:       setRow.scope,
      scope_id:    setRow.scope_id,
      exclusive:   setRow.exclusive === 1 || setRow.exclusive === true,
      archived_at: setRow.archived_at == null ? null : setRow.archived_at,
      created_at:  setRow.created_at,
      updated_at:  setRow.updated_at,
      tiers:       tierRows.map(function (t) {
        return {
          id:            t.id,
          min_quantity:  t.min_quantity,
          discount_kind: t.discount_kind,
          value:         t.value,
          sort_order:    t.sort_order,
        };
      }),
    };
  }

  // ---- defineTier ------------------------------------------------------

  async function defineTier(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("quantityDiscounts.defineTier: input object required");
    }
    _assertScope(input.scope);
    var scopeId = input.scope_id == null ? null : input.scope_id;
    _assertScopeIdShape(input.scope, scopeId);

    if (!Array.isArray(input.tiers) || input.tiers.length === 0) {
      throw new TypeError("quantityDiscounts.defineTier: tiers must be a non-empty array");
    }
    if (input.tiers.length > MAX_TIERS_PER_SET) {
      throw new TypeError("quantityDiscounts.defineTier: tiers length " + input.tiers.length +
                          " exceeds cap of " + MAX_TIERS_PER_SET);
    }

    var exclusive = input.exclusive === true ? 1 : 0;

    // Validate every tier shape AND refuse overlapping min_quantity
    // values within this set before any write. Overlap-refusal here
    // is the primary defense; the application layer is the only
    // place that knows the per-set context (SQL CHECKs can't span
    // rows in a single statement).
    var seenMin = Object.create(null);
    var prepped = [];
    for (var i = 0; i < input.tiers.length; i += 1) {
      var t = input.tiers[i];
      if (!t || typeof t !== "object") {
        throw new TypeError("quantityDiscounts.defineTier: tiers[" + i + "] must be an object");
      }
      _assertPositiveInt(t.min_quantity, "tiers[" + i + "].min_quantity");
      _assertKind(t.discount_kind);
      _assertValueForKind(t.discount_kind, t.value);
      if (seenMin[t.min_quantity]) {
        throw new TypeError("quantityDiscounts.defineTier: duplicate min_quantity " + t.min_quantity +
                            " — overlapping thresholds in one tier set are refused");
      }
      seenMin[t.min_quantity] = true;
      prepped.push({
        min_quantity:  t.min_quantity,
        discount_kind: t.discount_kind,
        value:         t.value,
      });
    }

    // For scope = 'sku', verify the SKU exists in the catalog. The
    // primitive composes catalog.variants.bySku to keep the
    // referential check live; scope = 'product' / 'vendor' /
    // 'category' / 'collection_slug' identifiers are opaque to this
    // primitive (the catalog primitive owns those namespaces and
    // doesn't expose a uniform lookup for them yet).
    if (input.scope === "sku") {
      var variant = await catalog.variants.bySku(scopeId);
      if (!variant) {
        throw new TypeError("quantityDiscounts.defineTier: sku " + JSON.stringify(scopeId) + " not found in catalog");
      }
    }

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO qd_tier_sets (id, scope, scope_id, exclusive, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)",
      [id, input.scope, scopeId, exclusive, ts],
    );
    for (var k = 0; k < prepped.length; k += 1) {
      var tierId = b.uuid.v7();
      await query(
        "INSERT INTO qd_tiers (id, tier_set_id, min_quantity, discount_kind, value, sort_order) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [tierId, id, prepped[k].min_quantity, prepped[k].discount_kind, prepped[k].value, k],
      );
    }
    var setRow = await _setRow(id);
    var tierRows = await _tierRowsForSet(id);
    return _shapeTierSet(setRow, tierRows);
  }

  // ---- getTiersForLine -------------------------------------------------

  // Find every active tier set whose scope matches some attribute of
  // the line, ordered most-specific first. The caller (cart-line
  // resolver) passes whatever scope identifiers it knows: sku is
  // required, product_id is required for product-scope matching,
  // and optional vendor / category / collection_slug travel as
  // context. Quantity also rides along so the active-rule pick can
  // happen in one walk.
  async function getTiersForLine(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("quantityDiscounts.getTiersForLine: input object required");
    }
    if (typeof input.sku !== "string" || !input.sku.length) {
      throw new TypeError("quantityDiscounts.getTiersForLine: sku required (non-empty string)");
    }
    _assertPositiveInt(input.quantity, "quantity");

    // Build the (scope, scope_id) candidates from the line context.
    // Missing attributes (e.g. no vendor on the line) skip that
    // scope's lookup entirely.
    var candidates = [];
    candidates.push({ scope: "sku", scope_id: input.sku });
    if (input.product_id != null) {
      candidates.push({ scope: "product", scope_id: String(input.product_id) });
    }
    if (input.collection_slug != null) {
      candidates.push({ scope: "collection_slug", scope_id: String(input.collection_slug) });
    }
    if (input.vendor != null) {
      candidates.push({ scope: "vendor", scope_id: String(input.vendor) });
    }
    if (input.category != null) {
      candidates.push({ scope: "category", scope_id: String(input.category) });
    }
    candidates.push({ scope: "global", scope_id: null });

    var results = [];
    for (var i = 0; i < candidates.length; i += 1) {
      var c = candidates[i];
      var setsRes;
      if (c.scope === "global") {
        setsRes = await query(
          "SELECT * FROM qd_tier_sets WHERE scope = 'global' AND archived_at IS NULL",
          [],
        );
      } else {
        setsRes = await query(
          "SELECT * FROM qd_tier_sets WHERE scope = ?1 AND scope_id = ?2 AND archived_at IS NULL",
          [c.scope, c.scope_id],
        );
      }
      for (var j = 0; j < setsRes.rows.length; j += 1) {
        var setRow = setsRes.rows[j];
        var tierRows = await _tierRowsForSet(setRow.id);
        // Filter to tier rules whose min_quantity is met by the
        // line's quantity. Higher-min rules are preferred when
        // multiple within one set apply — best-rule picking happens
        // in applyToLine via final-price compare.
        var applicable = tierRows.filter(function (t) { return input.quantity >= t.min_quantity; });
        if (applicable.length === 0) continue;
        results.push({
          tier_set:    _shapeTierSet(setRow, tierRows),
          specificity: SCOPE_SPECIFICITY[setRow.scope],
          applicable:  applicable,
        });
      }
    }

    // Sort by specificity desc so the caller (applyToLine) walks
    // most-specific first. Tie-broken by tier_set.id for stability
    // — two sets at the same scope sort deterministically.
    results.sort(function (a, b) {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      return a.tier_set.id < b.tier_set.id ? -1 : a.tier_set.id > b.tier_set.id ? 1 : 0;
    });
    return results;
  }

  // ---- applyToLine -----------------------------------------------------

  // Walk applicable tier sets, compute the candidate
  // (discounted_unit_minor, line_subtotal_minor, line_discount_minor)
  // for the best rule within each set, then pick the candidate with
  // the lowest line_subtotal_minor across all sets. If any set is
  // marked exclusive, its best-rule candidate (if applicable) wins
  // outright over non-exclusive sets even at higher cost — the
  // operator's intent is "this rule applies, ignore the rest".
  //
  // Pure function aside from the rule lookup. Money math routes
  // through b.money.fromMinorUnits + .multiply so half-even rounding
  // stays consistent with the framework's Money class.
  async function applyToLine(input) {
    if (!input || typeof input !== "object" || !input.line || typeof input.line !== "object") {
      throw new TypeError("quantityDiscounts.applyToLine: input.line object required");
    }
    var line = input.line;
    if (typeof line.sku !== "string" || !line.sku.length) {
      throw new TypeError("quantityDiscounts.applyToLine: line.sku required");
    }
    _assertPositiveInt(line.quantity, "line.quantity");
    _assertNonNegInt(line.unit_price_minor, "line.unit_price_minor");

    var rules = await getTiersForLine({
      sku:             line.sku,
      product_id:      line.product_id,
      quantity:        line.quantity,
      vendor:          line.vendor,
      category:        line.category,
      collection_slug: line.collection_slug,
    });

    var original = line.unit_price_minor;
    var qty      = line.quantity;
    var defaultResult = {
      original_unit_minor:    original,
      discounted_unit_minor:  original,
      line_subtotal_minor:    original * qty,
      line_discount_minor:    0,
      applied_tier_id:        null,
    };
    if (rules.length === 0) return defaultResult;

    // Compute the best candidate within each tier set, then choose
    // the best across sets respecting `exclusive`.
    var perSet = [];
    for (var i = 0; i < rules.length; i += 1) {
      var bucket = rules[i];
      var bestForSet = null;
      for (var j = 0; j < bucket.applicable.length; j += 1) {
        var t = bucket.applicable[j];
        var candidate = _applyRule(original, qty, t);
        if (!bestForSet || candidate.line_subtotal_minor < bestForSet.line_subtotal_minor) {
          bestForSet = candidate;
          bestForSet.applied_tier_id = t.id;
          bestForSet.tier_set_id     = bucket.tier_set.id;
          bestForSet.specificity     = bucket.specificity;
          bestForSet.exclusive       = bucket.tier_set.exclusive;
        }
      }
      if (bestForSet) perSet.push(bestForSet);
    }

    if (perSet.length === 0) return defaultResult;

    // Exclusive rules win outright. If multiple exclusive sets all
    // produce candidates, the most-specific one wins (ties broken
    // by lowest subtotal).
    var exclusives = perSet.filter(function (r) { return r.exclusive; });
    var pool = exclusives.length > 0 ? exclusives : perSet;

    var winner = pool[0];
    for (var k = 1; k < pool.length; k += 1) {
      var c = pool[k];
      if (c.line_subtotal_minor < winner.line_subtotal_minor) {
        winner = c;
      } else if (c.line_subtotal_minor === winner.line_subtotal_minor && c.specificity > winner.specificity) {
        winner = c;
      }
    }

    return {
      original_unit_minor:    winner.original_unit_minor,
      discounted_unit_minor:  winner.discounted_unit_minor,
      line_subtotal_minor:    winner.line_subtotal_minor,
      line_discount_minor:    winner.line_discount_minor,
      applied_tier_id:        winner.applied_tier_id,
    };
  }

  // ---- _applyRule (internal pure math) ---------------------------------

  // Compose the per-unit / per-line minor-unit math via b.money so
  // half-even rounding matches the framework Money class. Returns
  // integer minor units to the caller (the calling primitive
  // already speaks minor units).
  function _applyRule(originalUnit, qty, tier) {
    var money       = b.money;
    var currency    = "USD";                                                 // placeholder; the rounding behaviour is currency-exponent-independent for integer minor math here
    var discountedUnit;
    var lineSubtotal;

    if (tier.discount_kind === "percent_off") {
      // value is basis points (1/10000). discountedUnit =
      // floor((original * (10000 - bps)) / 10000) via b.money's
      // half-even rounded multiply on the BigInt-Money round trip.
      var keepBps = 10000 - tier.value;
      if (keepBps < 0) keepBps = 0;
      var pricedUnit = money.fromMinorUnits(BigInt(originalUnit), currency)
        .multiply([BigInt(keepBps), BigInt(10000)]);
      discountedUnit = Number(pricedUnit.toMinorUnits());
      if (discountedUnit < 0) discountedUnit = 0;
      lineSubtotal = discountedUnit * qty;
    } else if (tier.discount_kind === "amount_off_each") {
      discountedUnit = originalUnit - tier.value;
      if (discountedUnit < 0) discountedUnit = 0;
      lineSubtotal = discountedUnit * qty;
    } else if (tier.discount_kind === "amount_off_total") {
      var listLine = originalUnit * qty;
      lineSubtotal = listLine - tier.value;
      if (lineSubtotal < 0) lineSubtotal = 0;
      // Effective unit price for receipt-line display rounds
      // half-even via b.money — the storefront renders one number
      // per line, derived from the line subtotal.
      var effUnitMoney = money.fromMinorUnits(BigInt(lineSubtotal), currency)
        .multiply([1n, BigInt(qty)]);
      discountedUnit = Number(effUnitMoney.toMinorUnits());
    } else if (tier.discount_kind === "fixed_each_price") {
      discountedUnit = tier.value;
      if (discountedUnit < 0) discountedUnit = 0;
      lineSubtotal = discountedUnit * qty;
    } else {
      // Defensive — the kind enum is gated by _assertKind upstream,
      // but a future schema migration could widen the column ahead
      // of an app-layer update; refuse rather than silently apply
      // the wrong math.
      throw new TypeError("quantityDiscounts: unknown discount_kind " + JSON.stringify(tier.discount_kind));
    }

    var lineDiscount = (originalUnit * qty) - lineSubtotal;
    if (lineDiscount < 0) lineDiscount = 0;
    return {
      original_unit_minor:    originalUnit,
      discounted_unit_minor:  discountedUnit,
      line_subtotal_minor:    lineSubtotal,
      line_discount_minor:    lineDiscount,
    };
  }

  // ---- applyToCart -----------------------------------------------------

  async function applyToCart(input) {
    if (!input || typeof input !== "object" || !Array.isArray(input.lines)) {
      throw new TypeError("quantityDiscounts.applyToCart: input.lines array required");
    }
    var lines = input.lines;
    var perLine = [];
    var totalSubtotal = 0;
    var totalDiscount = 0;
    var totalOriginal = 0;
    for (var i = 0; i < lines.length; i += 1) {
      var r = await applyToLine({ line: lines[i] });
      perLine.push({
        sku:                   lines[i].sku,
        product_id:            lines[i].product_id == null ? null : lines[i].product_id,
        quantity:              lines[i].quantity,
        original_unit_minor:   r.original_unit_minor,
        discounted_unit_minor: r.discounted_unit_minor,
        line_subtotal_minor:   r.line_subtotal_minor,
        line_discount_minor:   r.line_discount_minor,
        applied_tier_id:       r.applied_tier_id,
      });
      totalSubtotal += r.line_subtotal_minor;
      totalDiscount += r.line_discount_minor;
      totalOriginal += r.original_unit_minor * lines[i].quantity;
    }
    return {
      lines:                 perLine,
      original_total_minor:  totalOriginal,
      discount_total_minor:  totalDiscount,
      subtotal_minor:        totalSubtotal,
    };
  }

  // ---- update / archive / unarchive / list -----------------------------

  async function update(tierSetId, patch) {
    if (typeof tierSetId !== "string" || !tierSetId.length) {
      throw new TypeError("quantityDiscounts.update: tier_set_id required");
    }
    if (!patch || typeof patch !== "object") {
      throw new TypeError("quantityDiscounts.update: patch object required");
    }
    var sets   = [];
    var params = [];
    var idx    = 1;
    function _addSet(col, val) {
      // Allow-list defense even though the column name is a
      // literal — a future patch-key path that becomes dynamic
      // can't widen the surface to an attacker-controlled column.
      b.safeSql.assertOneOf(col, ALLOWED_SET_COLUMNS);
      sets.push(b.safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (idx++));
      params.push(val);
    }
    if (patch.exclusive !== undefined) {
      if (typeof patch.exclusive !== "boolean") {
        throw new TypeError("quantityDiscounts.update: exclusive must be boolean");
      }
      _addSet("exclusive", patch.exclusive ? 1 : 0);
    }

    // Tier rewrite path — replace the set's rules wholesale,
    // applying the same overlap + shape checks as defineTier.
    if (patch.tiers !== undefined) {
      if (!Array.isArray(patch.tiers) || patch.tiers.length === 0) {
        throw new TypeError("quantityDiscounts.update: tiers must be a non-empty array");
      }
      if (patch.tiers.length > MAX_TIERS_PER_SET) {
        throw new TypeError("quantityDiscounts.update: tiers length " + patch.tiers.length +
                            " exceeds cap of " + MAX_TIERS_PER_SET);
      }
      var seenMin2 = Object.create(null);
      var newTiers = [];
      for (var i = 0; i < patch.tiers.length; i += 1) {
        var t = patch.tiers[i];
        if (!t || typeof t !== "object") {
          throw new TypeError("quantityDiscounts.update: tiers[" + i + "] must be an object");
        }
        _assertPositiveInt(t.min_quantity, "tiers[" + i + "].min_quantity");
        _assertKind(t.discount_kind);
        _assertValueForKind(t.discount_kind, t.value);
        if (seenMin2[t.min_quantity]) {
          throw new TypeError("quantityDiscounts.update: duplicate min_quantity " + t.min_quantity +
                              " — overlapping thresholds refused");
        }
        seenMin2[t.min_quantity] = true;
        newTiers.push({
          min_quantity:  t.min_quantity,
          discount_kind: t.discount_kind,
          value:         t.value,
        });
      }
      var existing = await _setRow(tierSetId);
      if (!existing) return null;
      await query("DELETE FROM qd_tiers WHERE tier_set_id = ?1", [tierSetId]);
      for (var m = 0; m < newTiers.length; m += 1) {
        var tid = b.uuid.v7();
        await query(
          "INSERT INTO qd_tiers (id, tier_set_id, min_quantity, discount_kind, value, sort_order) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
          [tid, tierSetId, newTiers[m].min_quantity, newTiers[m].discount_kind, newTiers[m].value, m],
        );
      }
    }
    if (sets.length === 0 && patch.tiers === undefined) {
      throw new TypeError("quantityDiscounts.update: patch contained no updatable fields");
    }
    var ts = _now();
    if (sets.length > 0) {
      sets.push("updated_at = ?" + (idx++));
      params.push(ts);
      params.push(tierSetId);
      var r = await query(
        "UPDATE qd_tier_sets SET " + sets.join(", ") + " WHERE id = ?" + idx,
        params,
      );
      if (r.rowCount === 0 && patch.tiers === undefined) return null;
    } else {
      // Tiers-only patch — still bump updated_at so the operator
      // sees the schedule recently moved.
      await query("UPDATE qd_tier_sets SET updated_at = ?1 WHERE id = ?2", [ts, tierSetId]);
    }
    var setRow = await _setRow(tierSetId);
    if (!setRow) return null;
    var tierRows = await _tierRowsForSet(tierSetId);
    return _shapeTierSet(setRow, tierRows);
  }

  async function archive(tierSetId) {
    if (typeof tierSetId !== "string" || !tierSetId.length) {
      throw new TypeError("quantityDiscounts.archive: tier_set_id required");
    }
    var ts = _now();
    var r = await query(
      "UPDATE qd_tier_sets SET archived_at = ?1, updated_at = ?1 WHERE id = ?2 AND archived_at IS NULL",
      [ts, tierSetId],
    );
    return r.rowCount > 0;
  }

  async function unarchive(tierSetId) {
    if (typeof tierSetId !== "string" || !tierSetId.length) {
      throw new TypeError("quantityDiscounts.unarchive: tier_set_id required");
    }
    var ts = _now();
    var r = await query(
      "UPDATE qd_tier_sets SET archived_at = NULL, updated_at = ?1 WHERE id = ?2 AND archived_at IS NOT NULL",
      [ts, tierSetId],
    );
    return r.rowCount > 0;
  }

  async function list(input) {
    input = input || {};
    var limit = input.limit == null ? 50 : input.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      throw new TypeError("quantityDiscounts.list: limit must be 1..." + MAX_LIMIT);
    }
    var where = [];
    var params = [];
    var idx = 1;
    if (input.scope !== undefined) {
      _assertScope(input.scope);
      where.push("scope = ?" + (idx++));
      params.push(input.scope);
    }
    // archived filter: false (default) = active only, true = archived
    // only, null = both. Explicit-tri lets the operator-facing list
    // distinguish "show me archived rules" from "show everything".
    if (input.archived === undefined || input.archived === false) {
      where.push("archived_at IS NULL");
    } else if (input.archived === true) {
      where.push("archived_at IS NOT NULL");
    } else if (input.archived !== null) {
      throw new TypeError("quantityDiscounts.list: archived must be boolean or null");
    }
    var sql = "SELECT * FROM qd_tier_sets" +
              (where.length ? " WHERE " + where.join(" AND ") : "") +
              " ORDER BY updated_at DESC, id DESC LIMIT ?" + (idx++);
    params.push(limit);
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      var setRow = r.rows[i];
      var tierRows = await _tierRowsForSet(setRow.id);
      out.push(_shapeTierSet(setRow, tierRows));
    }
    return out;
  }

  // ---- tierBreakdown ---------------------------------------------------

  // Operator-friendly display surface — the active tier schedule for
  // a (scope, scope_id) pair, rendered as a list of rows. Includes
  // the per-rule "discounted unit at min_quantity" so the operator
  // can sanity-check the schedule against a sample unit price.
  async function tierBreakdown(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("quantityDiscounts.tierBreakdown: input object required");
    }
    _assertScope(input.scope);
    var scopeId = input.scope_id == null ? null : input.scope_id;
    _assertScopeIdShape(input.scope, scopeId);
    var sampleUnit = input.sample_unit_price_minor;
    if (sampleUnit !== undefined) {
      _assertNonNegInt(sampleUnit, "sample_unit_price_minor");
    }

    var sql, params;
    if (input.scope === "global") {
      sql = "SELECT * FROM qd_tier_sets WHERE scope = 'global' AND archived_at IS NULL ORDER BY created_at ASC";
      params = [];
    } else {
      sql = "SELECT * FROM qd_tier_sets WHERE scope = ?1 AND scope_id = ?2 AND archived_at IS NULL ORDER BY created_at ASC";
      params = [input.scope, scopeId];
    }
    var setsRes = await query(sql, params);
    var rows = [];
    for (var i = 0; i < setsRes.rows.length; i += 1) {
      var setRow = setsRes.rows[i];
      var tierRows = await _tierRowsForSet(setRow.id);
      for (var j = 0; j < tierRows.length; j += 1) {
        var t = tierRows[j];
        var entry = {
          tier_set_id:   setRow.id,
          exclusive:     setRow.exclusive === 1 || setRow.exclusive === true,
          min_quantity:  t.min_quantity,
          discount_kind: t.discount_kind,
          value:         t.value,
        };
        if (sampleUnit !== undefined) {
          var candidate = _applyRule(sampleUnit, t.min_quantity, t);
          entry.sample_discounted_unit_minor = candidate.discounted_unit_minor;
          entry.sample_line_subtotal_minor   = candidate.line_subtotal_minor;
          entry.sample_line_discount_minor   = candidate.line_discount_minor;
        }
        rows.push(entry);
      }
    }
    return {
      scope:    input.scope,
      scope_id: scopeId,
      rows:     rows,
    };
  }

  return {
    defineTier:      defineTier,
    getTiersForLine: getTiersForLine,
    applyToLine:     applyToLine,
    applyToCart:     applyToCart,
    update:          update,
    archive:         archive,
    unarchive:       unarchive,
    list:            list,
    tierBreakdown:   tierBreakdown,
  };
}

module.exports = {
  create:               create,
  VALID_SCOPES:         VALID_SCOPES,
  VALID_KINDS:          VALID_KINDS,
  ALLOWED_SET_COLUMNS:  ALLOWED_SET_COLUMNS,
  MAX_TIERS_PER_SET:    MAX_TIERS_PER_SET,
};
