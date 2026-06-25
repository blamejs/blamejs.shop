"use strict";
/**
 * @module shop.cartBulkOps
 * @title  Cart bulk operations — B2B-style multi-line cart primitives
 *
 * @intro
 *   Composes on top of the existing `cart` primitive to add the
 *   bulk-and-overlay operations a wholesale / B2B storefront needs:
 *
 *     addLines        — insert N lines in one call with per-batch
 *                       atomicity (one bad SKU rolls back the whole
 *                       batch, nothing is half-applied).
 *     replaceLines    — overwrite the cart's line set in one call.
 *     clearLines      — drop every line.
 *     priceListApply  — rewrite the cart's `unit_amount_minor`
 *                       values from a wholesale overlay table.
 *     reorder         — clone the lines of a previous order into a
 *                       cart (SKUs that no longer resolve are
 *                       skipped with their reason captured).
 *     splitCart       — fan the cart out into N child carts grouped
 *                       by a caller-supplied grouper (vendor /
 *                       category / drop-ship supplier). The source
 *                       cart is marked `abandoned` once split.
 *     quoteForCart    — produce a printable customer-facing quote
 *                       (lines + per-line totals + cart totals)
 *                       without mutating the cart.
 *
 *   Atomicity model: every "bulk" call pre-flight-validates the
 *   entire input batch (every SKU resolves to a live variant, every
 *   qty is in range, every price is available) BEFORE writing
 *   anything. Validation failures throw with a `lines[N]: ...`
 *   message that identifies the offending row. This is the same
 *   "fail-the-batch on the first bad row" pattern the framework's
 *   `translations.bulkSet` uses — the database write only starts
 *   after every row has cleared its checks.
 *
 *   The factory accepts:
 *     query       — the same query function the rest of the shop
 *                   primitives consume (defaults to b.externalDb).
 *     cart        — REQUIRED. A cart-primitive handle. The bulk ops
 *                   call into it for status checks / current cart
 *                   reads; they don't bypass its lifecycle gates.
 *     catalog     — REQUIRED. Resolves SKU → variant + currency
 *                   price (the same handle the cart primitive
 *                   already needs).
 *     customers   — OPTIONAL. When present, `priceListApply` can
 *                   resolve the price list assigned to a customer
 *                   when the caller omits the explicit slug.
 *                   Operators without the customers primitive in
 *                   scope pass the slug explicitly on every call.
 *     lineGrouper — OPTIONAL. `(line, splitBy) => groupKey`. Called
 *                   by `splitCart` to map each line to the bucket
 *                   it belongs in. When absent, splitCart refuses —
 *                   no built-in heuristic is honest enough to map
 *                   a SKU to a vendor / category / supplier without
 *                   a real lookup. Compose this against whatever
 *                   the operator's data model uses (variants
 *                   options_json axes, a separate vendors table,
 *                   etc.).
 */

var b = require("./vendor/blamejs");
var C = b.constants;

var SLUG_RE     = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;
var SKU_RE      = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CURRENCY_RE = /^[A-Z]{3}$/;
var MAX_BULK    = 500;
// The per-line quantity ceiling is owned by the cart primitive — source it
// from there so bulk operations and cart.addLine never diverge on the max a
// single line may hold. A hand-copied value had drifted 10x lower, which made
// a line legitimately built past it via cart.addLine un-bulk-addable (addLines
// threw) and silently clamped on reorder. (cart.js does not require this
// module, so the top-level require is acyclic.)
var MAX_QTY     = require("./cart").MAX_QTY;
var SPLIT_BY    = Object.freeze(["vendor", "category", "drop_ship_supplier"]);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("cartBulkOps: " + label + " — " + (e && e.message || "invalid UUID")); }
}
function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("cartBulkOps: " + label + " must match /^[a-z0-9][a-z0-9-]*[a-z0-9]?$/");
  }
}
function _sku(s, label) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("cartBulkOps: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ 128 chars)");
  }
}
function _qty(n, label) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_QTY) {
    throw new TypeError("cartBulkOps: " + label + " must be a positive integer ≤ " + MAX_QTY);
  }
}
function _splitBy(s) {
  if (SPLIT_BY.indexOf(s) === -1) {
    throw new TypeError("cartBulkOps: split_by must be one of " + SPLIT_BY.join(", "));
  }
}
function _linesArray(lines) {
  if (!Array.isArray(lines)) {
    throw new TypeError("cartBulkOps: lines must be an array");
  }
  if (lines.length > MAX_BULK) {
    throw new TypeError("cartBulkOps: lines must be ≤ " + MAX_BULK + " rows per call");
  }
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.cart)    throw new TypeError("cartBulkOps.create: cart handle required");
  if (!opts.catalog) throw new TypeError("cartBulkOps.create: catalog handle required");
  var cart      = opts.cart;
  var catalog   = opts.catalog;
  var customers = opts.customers   || null;
  var grouper   = opts.lineGrouper || null;
  var query     = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Pre-flight: resolve every {sku, qty} row to {variant, sku, qty,
  // unit_amount_minor, unit_currency}. Throws on the first row that
  // fails — caller sees the index of the bad row in the message so
  // the offending input is identifiable without a re-walk.
  async function _resolveBatch(cartRow, lines, label) {
    _linesArray(lines);
    var resolved = [];
    for (var i = 0; i < lines.length; i += 1) {
      var l = lines[i];
      if (!l || typeof l !== "object") {
        throw new TypeError("cartBulkOps." + label + ": lines[" + i + "] must be an object");
      }
      try { _sku(l.sku, "lines[" + i + "].sku"); }
      catch (e) { throw e; }
      _qty(l.qty, "lines[" + i + "].qty");
      var variant = await catalog.variants.bySku(l.sku);
      if (!variant) {
        throw new TypeError("cartBulkOps." + label + ": lines[" + i + "].sku — variant '" + l.sku + "' not found");
      }
      var unitAmount;
      var unitCurrency;
      if (l.unit_amount_minor != null && l.unit_currency != null) {
        if (!Number.isInteger(l.unit_amount_minor) || l.unit_amount_minor < 0) {
          throw new TypeError("cartBulkOps." + label + ": lines[" + i + "].unit_amount_minor must be a non-negative integer");
        }
        if (typeof l.unit_currency !== "string" || !CURRENCY_RE.test(l.unit_currency)) {
          throw new TypeError("cartBulkOps." + label + ": lines[" + i + "].unit_currency must be a 3-letter ISO 4217 code");
        }
        unitAmount = l.unit_amount_minor;
        unitCurrency = l.unit_currency;
      } else {
        var price = await catalog.prices.current(variant.id, cartRow.currency);
        if (!price) {
          throw new TypeError("cartBulkOps." + label + ": lines[" + i + "].sku — no current price for '" + l.sku + "' in " + cartRow.currency);
        }
        unitAmount = price.amount_minor;
        unitCurrency = price.currency;
      }
      resolved.push({
        variant:           variant,
        sku:               variant.sku,
        qty:               l.qty,
        unit_amount_minor: unitAmount,
        unit_currency:     unitCurrency,
      });
    }
    return resolved;
  }

  async function _loadCart(cartId) {
    var c = await cart.get(cartId);
    if (!c) throw new TypeError("cartBulkOps: cart " + cartId + " not found");
    if (c.status !== "active") {
      throw new TypeError("cartBulkOps: cart status is " + c.status + ", cannot modify");
    }
    return c;
  }

  async function _insertLineDirect(cartId, resolved, ts) {
    var id = b.uuid.v7();
    await query(
      "INSERT INTO cart_lines (id, cart_id, variant_id, sku, qty, unit_amount_minor, unit_currency, added_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
      [id, cartId, resolved.variant.id, resolved.sku, resolved.qty, resolved.unit_amount_minor, resolved.unit_currency, ts],
    );
    return {
      id:                id,
      cart_id:           cartId,
      variant_id:        resolved.variant.id,
      sku:               resolved.sku,
      qty:               resolved.qty,
      unit_amount_minor: resolved.unit_amount_minor,
      unit_currency:     resolved.unit_currency,
      added_at:          ts,
      updated_at:        ts,
    };
  }

  return {
    SPLIT_BY:    SPLIT_BY,
    MAX_BULK:    MAX_BULK,

    // Atomic bulk add. Every line in `lines` is pre-flight resolved
    // against catalog (variant lookup + price snapshot). If any row
    // fails resolution the whole batch is refused — no lines are
    // written. Successful calls collapse duplicates (same SKU twice
    // in the batch, OR same SKU already on the cart) by summing qty.
    addLines: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("cartBulkOps.addLines: input object required");
      _uuid(input.cart_id, "cart_id");
      var cartRow = await _loadCart(input.cart_id);
      var resolved = await _resolveBatch(cartRow, input.lines, "addLines");
      if (resolved.length === 0) return { written: 0, lines: [] };

      // Collapse duplicates within the batch by SKU.
      var bySku = {};
      var order = [];
      for (var i = 0; i < resolved.length; i += 1) {
        var r = resolved[i];
        if (bySku[r.sku]) {
          bySku[r.sku].qty += r.qty;
        } else {
          bySku[r.sku] = r;
          order.push(r.sku);
        }
        _qty(bySku[r.sku].qty, "lines[" + i + "].qty");
      }

      // Load existing lines once so per-SKU upsert doesn't query in
      // a loop. Map by variant_id (the cart_lines UNIQUE key).
      var existingRows = (await query(
        "SELECT * FROM cart_lines WHERE cart_id = ?1",
        [input.cart_id],
      )).rows;
      var existingByVariant = {};
      for (var ei = 0; ei < existingRows.length; ei += 1) {
        existingByVariant[existingRows[ei].variant_id] = existingRows[ei];
      }

      var ts = _now();
      var written = [];
      for (var oi = 0; oi < order.length; oi += 1) {
        var key = order[oi];
        var rr = bySku[key];
        var existing = existingByVariant[rr.variant.id];
        if (existing) {
          var newQty = existing.qty + rr.qty;
          _qty(newQty, "lines[" + oi + "].qty (summed with existing)");
          await query(
            "UPDATE cart_lines SET qty = ?1, updated_at = ?2 WHERE id = ?3",
            [newQty, ts, existing.id],
          );
          written.push(Object.assign({}, existing, { qty: newQty, updated_at: ts }));
        } else {
          written.push(await _insertLineDirect(input.cart_id, rr, ts));
        }
      }
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, input.cart_id]);
      return { written: written.length, lines: written };
    },

    // Overwrite the cart's line set. Same atomicity story: every
    // input row is resolved before the existing rows are dropped,
    // so a bad SKU never empties a cart and leaves it half-filled.
    replaceLines: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("cartBulkOps.replaceLines: input object required");
      _uuid(input.cart_id, "cart_id");
      var cartRow = await _loadCart(input.cart_id);
      var resolved = await _resolveBatch(cartRow, input.lines, "replaceLines");
      // Collapse duplicates within the replacement set by SKU.
      var bySku = {};
      var order = [];
      for (var i = 0; i < resolved.length; i += 1) {
        var r = resolved[i];
        if (bySku[r.sku]) {
          bySku[r.sku].qty += r.qty;
        } else {
          bySku[r.sku] = r;
          order.push(r.sku);
        }
        _qty(bySku[r.sku].qty, "lines[" + i + "].qty");
      }
      var ts = _now();
      await query("DELETE FROM cart_lines WHERE cart_id = ?1", [input.cart_id]);
      var written = [];
      for (var oi = 0; oi < order.length; oi += 1) {
        written.push(await _insertLineDirect(input.cart_id, bySku[order[oi]], ts));
      }
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, input.cart_id]);
      return { written: written.length, lines: written };
    },

    clearLines: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("cartBulkOps.clearLines: input object required");
      _uuid(input.cart_id, "cart_id");
      await _loadCart(input.cart_id);
      var ts = _now();
      var r = await query("DELETE FROM cart_lines WHERE cart_id = ?1", [input.cart_id]);
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, input.cart_id]);
      return { removed: r.rowCount };
    },

    // Apply a wholesale price list to the cart. Each existing cart
    // line whose SKU appears in `price_list_members` has its
    // `unit_amount_minor` rewritten to the override. Lines whose
    // SKU is not in the overlay are left untouched (the retail
    // snapshot they were added with stays put). Currency mismatch
    // between the overlay and the cart is refused.
    //
    // Resolution order for the slug:
    //   1. input.price_list_slug (explicit)
    //   2. price_list_assignments[customer_id] (when the caller
    //      passes customer_id and the assignment row exists)
    priceListApply: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("cartBulkOps.priceListApply: input object required");
      _uuid(input.cart_id, "cart_id");
      var cartRow = await _loadCart(input.cart_id);

      var slug = null;
      if (input.price_list_slug != null) {
        _slug(input.price_list_slug, "price_list_slug");
        slug = input.price_list_slug;
      } else if (input.customer_id != null) {
        _uuid(input.customer_id, "customer_id");
        var assn = (await query(
          "SELECT price_list_slug FROM price_list_assignments WHERE customer_id = ?1",
          [input.customer_id],
        )).rows[0];
        if (!assn) {
          throw new TypeError("cartBulkOps.priceListApply: customer " + input.customer_id + " has no price-list assignment");
        }
        slug = assn.price_list_slug;
      } else {
        throw new TypeError("cartBulkOps.priceListApply: price_list_slug or customer_id required");
      }
      // Touch the customers handle when supplied so an operator
      // wiring it through gets a chance to validate that the
      // customer exists. Optional dependency — refused-silent when
      // the handle is not present is the documented behaviour.
      if (customers && input.customer_id) {
        var custRow = await customers.get(input.customer_id);
        if (!custRow) {
          throw new TypeError("cartBulkOps.priceListApply: customer " + input.customer_id + " not found");
        }
      }

      var list = (await query(
        "SELECT * FROM price_lists WHERE slug = ?1",
        [slug],
      )).rows[0];
      if (!list) {
        throw new TypeError("cartBulkOps.priceListApply: price list '" + slug + "' not found");
      }
      if (list.archived_at != null || list.active === 0) {
        throw new TypeError("cartBulkOps.priceListApply: price list '" + slug + "' is not active");
      }
      if (list.currency !== cartRow.currency) {
        throw new TypeError("cartBulkOps.priceListApply: price list currency " + list.currency + " does not match cart currency " + cartRow.currency);
      }

      var members = (await query(
        "SELECT sku, override_unit_minor FROM price_list_members WHERE price_list_slug = ?1",
        [slug],
      )).rows;
      var bySku = {};
      for (var mi = 0; mi < members.length; mi += 1) {
        bySku[members[mi].sku] = members[mi].override_unit_minor;
      }

      var lines = await cart.listLines(input.cart_id);
      var ts = _now();
      var overridden = 0;
      var skipped = 0;
      for (var li = 0; li < lines.length; li += 1) {
        var line = lines[li];
        if (Object.prototype.hasOwnProperty.call(bySku, line.sku)) {
          await query(
            "UPDATE cart_lines SET unit_amount_minor = ?1, updated_at = ?2 WHERE id = ?3",
            [bySku[line.sku], ts, line.id],
          );
          overridden += 1;
        } else {
          skipped += 1;
        }
      }
      if (overridden > 0) {
        await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, input.cart_id]);
      }
      return {
        price_list_slug: slug,
        overridden:      overridden,
        skipped:         skipped,
      };
    },

    // Clone a prior order's lines into a cart. Lines whose SKU no
    // longer resolves to a live variant are skipped — they appear
    // in the returned `skipped` array with their reason so the
    // storefront can render "we couldn't add 2 items from your
    // last order" affordances.
    reorder: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("cartBulkOps.reorder: input object required");
      _uuid(input.cart_id, "cart_id");
      _uuid(input.source_order_id, "source_order_id");
      var cartRow = await _loadCart(input.cart_id);

      var sourceLines = (await query(
        "SELECT * FROM order_lines WHERE order_id = ?1",
        [input.source_order_id],
      )).rows;
      if (sourceLines.length === 0) {
        throw new TypeError("cartBulkOps.reorder: source order " + input.source_order_id + " has no lines");
      }

      var added = [];
      var skipped = [];
      var ts = _now();
      for (var i = 0; i < sourceLines.length; i += 1) {
        var sl = sourceLines[i];
        var variant = await catalog.variants.bySku(sl.sku);
        if (!variant) {
          skipped.push({ sku: sl.sku, qty: sl.qty, reason: "variant-not-found" });
          continue;
        }
        if (variant.archived_at != null) {
          skipped.push({ sku: sl.sku, qty: sl.qty, reason: "variant-archived" });
          continue;
        }
        var price = await catalog.prices.current(variant.id, cartRow.currency);
        if (!price) {
          skipped.push({ sku: sl.sku, qty: sl.qty, reason: "no-current-price" });
          continue;
        }
        // Upsert into the cart by variant_id.
        var existing = (await query(
          "SELECT * FROM cart_lines WHERE cart_id = ?1 AND variant_id = ?2 LIMIT 1",
          [input.cart_id, variant.id],
        )).rows[0];
        if (existing) {
          var newQty = existing.qty + sl.qty;
          if (newQty > MAX_QTY) newQty = MAX_QTY;
          await query(
            "UPDATE cart_lines SET qty = ?1, updated_at = ?2 WHERE id = ?3",
            [newQty, ts, existing.id],
          );
          added.push(Object.assign({}, existing, { qty: newQty, updated_at: ts }));
        } else {
          added.push(await _insertLineDirect(input.cart_id, {
            variant:           variant,
            sku:               variant.sku,
            qty:               sl.qty,
            unit_amount_minor: price.amount_minor,
            unit_currency:     price.currency,
          }, ts));
        }
      }
      if (added.length > 0) {
        await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, input.cart_id]);
      }
      return {
        source_order_id: input.source_order_id,
        added:           added.length,
        skipped:         skipped,
        lines:           added,
      };
    },

    // Split a cart by a caller-supplied grouper into N child carts.
    // The grouper is required (no built-in heuristic for vendor /
    // category / supplier — the operator's data model is what
    // resolves the mapping). The source cart is marked `abandoned`
    // on success so the shopper isn't left with both the source
    // and the children active at once.
    splitCart: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("cartBulkOps.splitCart: input object required");
      _uuid(input.cart_id, "cart_id");
      _splitBy(input.split_by);
      if (!grouper) {
        throw new TypeError("cartBulkOps.splitCart: opts.lineGrouper required at create() time to split a cart");
      }
      var cartRow = await _loadCart(input.cart_id);
      var lines = await cart.listLines(input.cart_id);
      if (lines.length === 0) {
        throw new TypeError("cartBulkOps.splitCart: cart has no lines to split");
      }

      // Pre-flight: every line must group to a non-empty string.
      var byGroup = {};
      var groupOrder = [];
      for (var i = 0; i < lines.length; i += 1) {
        var g = await grouper(lines[i], input.split_by);
        if (typeof g !== "string" || !g.length) {
          throw new TypeError("cartBulkOps.splitCart: lineGrouper returned a non-string / empty value for lines[" + i + "].sku=" + lines[i].sku);
        }
        if (!byGroup[g]) {
          byGroup[g] = [];
          groupOrder.push(g);
        }
        byGroup[g].push(lines[i]);
      }
      if (groupOrder.length < 2) {
        // Splitting into one group is a no-op that mutates state
        // (would abandon the source for no reason). Refuse instead.
        throw new TypeError("cartBulkOps.splitCart: every line grouped to '" + groupOrder[0] + "' — nothing to split");
      }

      // Mint one child cart per group, copy lines, then mark the
      // source cart abandoned. Each child cart gets a fresh
      // session_id derived from a UUIDv7 so the partial-unique
      // active-session index doesn't refuse them (the source cart
      // is abandoned before the children are inserted, but using
      // a fresh session_id per child is the right shape — child
      // carts are not the shopper's working cart, they're scratch
      // carts for downstream fulfillment / split-order quoting).
      var ts = _now();
      // Atomic claim: mark the source abandoned in a single
      // conditional UPDATE that re-checks `status = 'active'` in its
      // own WHERE. `_loadCart` read the status in JS, but two
      // concurrent splitCart calls would both pass that check and
      // both mint a full set of child carts (double-create). SQLite /
      // D1 serializes writers, so exactly one of the racing UPDATEs
      // flips active→abandoned (rowCount === 1) and earns the right
      // to mint the children; the loser sees rowCount === 0 and
      // refuses rather than producing a second set of child carts.
      // This also frees the active-session index for any reuse.
      var claim = await query(
        "UPDATE carts SET status = 'abandoned', updated_at = ?1 WHERE id = ?2 AND status = 'active'",
        [ts, input.cart_id],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        throw new TypeError("cartBulkOps.splitCart: cart " + input.cart_id + " already split/modified");
      }
      var children = [];
      for (var gi = 0; gi < groupOrder.length; gi += 1) {
        var groupKey = groupOrder[gi];
        var childId = b.uuid.v7();
        var childSession = "sess_" + b.uuid.v7().replace(/-/g, "").slice(0, 24);
        var childExpires = ts + C.TIME.days(1);
        await query(
          "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
          "VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5, ?6)",
          [childId, childSession, cartRow.customer_id, cartRow.currency, ts, childExpires],
        );
        var groupLines = byGroup[groupKey];
        for (var li = 0; li < groupLines.length; li += 1) {
          var l = groupLines[li];
          await query(
            "INSERT INTO cart_lines (id, cart_id, variant_id, sku, qty, unit_amount_minor, unit_currency, added_at, updated_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            [b.uuid.v7(), childId, l.variant_id, l.sku, l.qty, l.unit_amount_minor, l.unit_currency, ts],
          );
        }
        children.push({
          cart_id:    childId,
          group_key:  groupKey,
          line_count: groupLines.length,
        });
      }
      return {
        split_by:        input.split_by,
        source_cart_id:  input.cart_id,
        children:        children,
      };
    },

    // Render a customer-facing quote. Read-only — never mutates.
    // The shape is deliberately operator-renderable (HTML / PDF /
    // plain-text) without re-reading from the database. Totals are
    // computed in minor units; currency formatting is the
    // storefront's job, not the primitive's.
    quoteForCart: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("cartBulkOps.quoteForCart: input object required");
      _uuid(input.cart_id, "cart_id");
      var cartRow = await cart.get(input.cart_id);
      if (!cartRow) throw new TypeError("cartBulkOps.quoteForCart: cart " + input.cart_id + " not found");
      var lines = await cart.listLines(input.cart_id);

      var quoteLines = [];
      var subtotalMinor = 0;
      var lineCount = 0;
      var unitCount = 0;
      for (var i = 0; i < lines.length; i += 1) {
        var l = lines[i];
        if (l.unit_currency !== cartRow.currency) {
          // A mixed-currency cart is a data integrity failure; the
          // quote should surface it loudly rather than silently
          // pretend the sum is meaningful.
          throw new TypeError("cartBulkOps.quoteForCart: cart line " + l.id + " currency " + l.unit_currency + " does not match cart currency " + cartRow.currency);
        }
        var lineTotal = l.qty * l.unit_amount_minor;
        subtotalMinor += lineTotal;
        lineCount += 1;
        unitCount += l.qty;
        quoteLines.push({
          line_id:           l.id,
          sku:               l.sku,
          qty:               l.qty,
          unit_amount_minor: l.unit_amount_minor,
          line_total_minor:  lineTotal,
        });
      }

      return {
        cart_id:        cartRow.id,
        customer_id:    cartRow.customer_id,
        currency:       cartRow.currency,
        generated_at:   _now(),
        lines:          quoteLines,
        line_count:     lineCount,
        unit_count:     unitCount,
        subtotal_minor: subtotalMinor,
      };
    },

    // ---- price-list admin --------------------------------------------
    //
    // The bulk-ops primitive owns the small admin surface for the
    // wholesale overlay tables since they're its domain — no other
    // primitive reads or writes them. Operators wire these into
    // their admin UI; the storefront never sees the raw write
    // surface.
    priceLists: {
      create: async function (input) {
        if (!input || typeof input !== "object") throw new TypeError("cartBulkOps.priceLists.create: input object required");
        _slug(input.slug, "slug");
        if (typeof input.title !== "string" || !input.title.length) {
          throw new TypeError("cartBulkOps.priceLists.create: title required (non-empty string)");
        }
        if (typeof input.currency !== "string" || !CURRENCY_RE.test(input.currency)) {
          throw new TypeError("cartBulkOps.priceLists.create: currency must be a 3-letter ISO 4217 code");
        }
        var desc = input.description == null ? "" : String(input.description);
        var ts = _now();
        await query(
          "INSERT INTO price_lists (slug, title, description, currency, active, archived_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, 1, NULL, ?5, ?5)",
          [input.slug, input.title, desc, input.currency, ts],
        );
        return (await query("SELECT * FROM price_lists WHERE slug = ?1", [input.slug])).rows[0];
      },
      setMember: async function (input) {
        if (!input || typeof input !== "object") throw new TypeError("cartBulkOps.priceLists.setMember: input object required");
        _slug(input.price_list_slug, "price_list_slug");
        _sku(input.sku, "sku");
        if (!Number.isInteger(input.override_unit_minor) || input.override_unit_minor < 0) {
          throw new TypeError("cartBulkOps.priceLists.setMember: override_unit_minor must be a non-negative integer");
        }
        var qb = input.qty_break_minor == null ? null : input.qty_break_minor;
        if (qb != null && (!Number.isInteger(qb) || qb < 0)) {
          throw new TypeError("cartBulkOps.priceLists.setMember: qty_break_minor must be a non-negative integer or null");
        }
        var ts = _now();
        var existing = (await query(
          "SELECT id FROM price_list_members WHERE price_list_slug = ?1 AND sku = ?2",
          [input.price_list_slug, input.sku],
        )).rows[0];
        if (existing) {
          await query(
            "UPDATE price_list_members SET override_unit_minor = ?1, qty_break_minor = ?2 WHERE id = ?3",
            [input.override_unit_minor, qb, existing.id],
          );
          return (await query("SELECT * FROM price_list_members WHERE id = ?1", [existing.id])).rows[0];
        }
        var id = b.uuid.v7();
        await query(
          "INSERT INTO price_list_members (id, price_list_slug, sku, override_unit_minor, qty_break_minor, created_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
          [id, input.price_list_slug, input.sku, input.override_unit_minor, qb, ts],
        );
        return (await query("SELECT * FROM price_list_members WHERE id = ?1", [id])).rows[0];
      },
      assign: async function (input) {
        if (!input || typeof input !== "object") throw new TypeError("cartBulkOps.priceLists.assign: input object required");
        _uuid(input.customer_id, "customer_id");
        _slug(input.price_list_slug, "price_list_slug");
        var ts = _now();
        // Upsert — re-assigning a customer to a different list
        // overwrites the prior row in place.
        var existing = (await query(
          "SELECT customer_id FROM price_list_assignments WHERE customer_id = ?1",
          [input.customer_id],
        )).rows[0];
        if (existing) {
          await query(
            "UPDATE price_list_assignments SET price_list_slug = ?1 WHERE customer_id = ?2",
            [input.price_list_slug, input.customer_id],
          );
        } else {
          await query(
            "INSERT INTO price_list_assignments (customer_id, price_list_slug, created_at) " +
            "VALUES (?1, ?2, ?3)",
            [input.customer_id, input.price_list_slug, ts],
          );
        }
        return (await query(
          "SELECT * FROM price_list_assignments WHERE customer_id = ?1",
          [input.customer_id],
        )).rows[0];
      },
      listMembers: async function (slug) {
        _slug(slug, "slug");
        var r = await query(
          "SELECT * FROM price_list_members WHERE price_list_slug = ?1 ORDER BY sku ASC",
          [slug],
        );
        return r.rows;
      },
    },
  };
}

module.exports = {
  create:   create,
  SPLIT_BY: SPLIT_BY,
  MAX_BULK: MAX_BULK,
};
