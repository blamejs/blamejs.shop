"use strict";
/**
 * @module shop.cart
 * @title  Cart primitive — anonymous + authenticated shopping carts
 *
 * @intro
 *   Persistent carts keyed by a `session_id` carried in a sealed
 *   cookie (set by the storefront route layer). Anonymous shoppers
 *   get a cart with `customer_id = NULL`; on customer login the
 *   shop calls `cart.merge(anonId, customerCartId)` so the
 *   shopper's working cart adopts the authenticated identity. The
 *   cart row survives container restarts (D1, not session-memory).
 *
 *   Price snapshots: every line captures the current
 *   `prices.current(variant, currency)` at add time and stores
 *   `unit_amount_minor` + `unit_currency` on the line. A later
 *   `catalog.prices.set()` doesn't silently re-price an in-flight
 *   cart — the storefront can show "price changed" notices by
 *   diffing the line snapshot against the current price.
 *
 *   Lifecycle status:
 *     active     — the shopper's working cart (one per session_id)
 *     abandoned  — expired or explicitly abandoned
 *     converted  — checkout completed; immutable post-conversion
 */

var b = require("./vendor/blamejs");
// Framework constants (C.TIME / C.BYTES duration + byte helpers). The
// index entry point exposes `framework` before the require cascade, so
// resolving this at module-eval is safe.
var C = b.constants;

var CART_STATUSES   = Object.freeze(["active", "abandoned", "converted"]);
var DEFAULT_TTL_MS  = C.TIME.days(30);
var MAX_QTY         = 99999;
var SESSION_ID_RE   = /^[A-Za-z0-9_-]{16,64}$/;   // shape-only; sealed-cookie origin
var CURRENCY_RE     = /^[A-Z]{3}$/;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("cart: " + label + " — " + (e && e.message || "invalid UUID")); }
}
function _sessionId(s) {
  if (typeof s !== "string" || !SESSION_ID_RE.test(s)) {
    throw new TypeError("cart: session_id must be 16-64 chars of [A-Za-z0-9_-]");
  }
}
function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("cart: currency must be a 3-letter ISO 4217 code (uppercase)");
  }
}
function _qty(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_QTY) {
    throw new TypeError("cart: qty must be a positive integer ≤ " + MAX_QTY);
  }
}
function _status(s) {
  if (CART_STATUSES.indexOf(s) === -1) {
    throw new TypeError("cart: status must be one of " + CART_STATUSES.join(", "));
  }
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional catalog handle — when present, addLine looks up the
  // current price for the variant + currency to snapshot onto the
  // line. Callers may also pass an explicit price snapshot in
  // `addLine(...)` for testing or for off-catalog items.
  var catalog = opts.catalog || null;
  var ttlMs   = opts.ttlMs   || DEFAULT_TTL_MS;

  return {
    create: async function (sessionId, input) {
      _sessionId(sessionId);
      input = input || {};
      _currency(input.currency);
      var id = b.uuid.v7();
      var ts = _now();
      var expires = ts + ttlMs;
      await query(
        "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
        "VALUES (?1, ?2, NULL, ?3, 'active', ?4, ?4, ?5)",
        [id, sessionId, input.currency, ts, expires],
      );
      return { id: id, session_id: sessionId, customer_id: null, currency: input.currency, status: "active", created_at: ts, updated_at: ts, expires_at: expires };
    },

    get: async function (id) {
      _uuid(id, "cart id");
      var r = await query("SELECT * FROM carts WHERE id = ?1", [id]);
      return r.rows[0] || null;
    },

    bySession: async function (sessionId) {
      _sessionId(sessionId);
      // Active row per session is unique via the partial UNIQUE
      // index in the migration, so LIMIT 1 is safe.
      var r = await query(
        "SELECT * FROM carts WHERE session_id = ?1 AND status = 'active' LIMIT 1",
        [sessionId],
      );
      return r.rows[0] || null;
    },

    listLines: async function (cartId) {
      _uuid(cartId, "cart_id");
      var r = await query(
        "SELECT * FROM cart_lines WHERE cart_id = ?1 ORDER BY added_at ASC",
        [cartId],
      );
      return r.rows;
    },

    // Adds qty to an existing variant line if present, else inserts
    // a new line. Price snapshot resolution order:
    //   1. input.unit_amount_minor + input.unit_currency (explicit)
    //   2. catalog.prices.current(variant_id, cart.currency) (implicit)
    // If neither yields a price, the call throws.
    addLine: async function (cartId, input) {
      _uuid(cartId, "cart_id");
      if (!input || typeof input !== "object") throw new TypeError("cart.addLine: input object required");
      _uuid(input.variant_id, "variant_id");
      _qty(input.qty);
      // Pull the parent cart for currency + status + variant SKU.
      var cartRow = (await query("SELECT * FROM carts WHERE id = ?1", [cartId])).rows[0];
      if (!cartRow) throw new TypeError("cart.addLine: cart " + cartId + " not found");
      if (cartRow.status !== "active") throw new TypeError("cart.addLine: cart status is " + cartRow.status + ", cannot modify");
      // Resolve price snapshot.
      var unitAmount = null;
      var unitCurrency = null;
      if (input.unit_amount_minor != null && input.unit_currency != null) {
        if (!Number.isInteger(input.unit_amount_minor) || input.unit_amount_minor < 0) {
          throw new TypeError("cart.addLine: unit_amount_minor must be a non-negative integer");
        }
        if (typeof input.unit_currency !== "string" || !CURRENCY_RE.test(input.unit_currency)) {
          throw new TypeError("cart.addLine: unit_currency must be a 3-letter ISO 4217 code");
        }
        unitAmount = input.unit_amount_minor;
        unitCurrency = input.unit_currency;
      } else {
        if (!catalog) throw new Error("cart.addLine: no catalog handle and no explicit price snapshot — cannot resolve unit price");
        var price = await catalog.prices.current(input.variant_id, cartRow.currency);
        if (!price) throw new TypeError("cart.addLine: no current price for variant " + input.variant_id + " in " + cartRow.currency);
        unitAmount = price.amount_minor;
        unitCurrency = price.currency;
      }
      // Fetch variant SKU for the line snapshot.
      var variantRow = (await query("SELECT sku FROM variants WHERE id = ?1", [input.variant_id])).rows[0];
      if (!variantRow) throw new TypeError("cart.addLine: variant " + input.variant_id + " not found");
      // Upsert: if a line for this (cart, variant) exists, bump qty.
      var existing = (await query(
        "SELECT * FROM cart_lines WHERE cart_id = ?1 AND variant_id = ?2 LIMIT 1",
        [cartId, input.variant_id],
      )).rows[0];
      var ts = _now();
      if (existing) {
        var newQty = existing.qty + input.qty;
        _qty(newQty);
        await query(
          "UPDATE cart_lines SET qty = ?1, updated_at = ?2 WHERE id = ?3",
          [newQty, ts, existing.id],
        );
        await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, cartId]);
        return Object.assign({}, existing, { qty: newQty, updated_at: ts });
      }
      var id = b.uuid.v7();
      await query(
        "INSERT INTO cart_lines (id, cart_id, variant_id, sku, qty, unit_amount_minor, unit_currency, added_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        [id, cartId, input.variant_id, variantRow.sku, input.qty, unitAmount, unitCurrency, ts],
      );
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, cartId]);
      return { id: id, cart_id: cartId, variant_id: input.variant_id, sku: variantRow.sku, qty: input.qty, unit_amount_minor: unitAmount, unit_currency: unitCurrency, added_at: ts, updated_at: ts };
    },

    // Scope the mutation to (lineId, cartId): a caller who learns
    // another visitor's cart_lines.id (it's rendered in their own cart
    // HTML as the update/remove form action) can't mutate it because
    // the row only matches when it also belongs to the caller's session
    // cart. A cross-cart id matches zero rows and becomes a no-op
    // (returns null), never a mutation. cartId is required — every
    // caller resolves the session cart first.
    updateLine: async function (lineId, cartId, patch) {
      _uuid(lineId, "line id");
      _uuid(cartId, "cart_id");
      if (!patch || typeof patch !== "object") throw new TypeError("cart.updateLine: patch object required");
      if (patch.qty == null) throw new TypeError("cart.updateLine: qty is the only updatable field");
      _qty(patch.qty);
      var ts = _now();
      var r = await query(
        "UPDATE cart_lines SET qty = ?1, updated_at = ?2 WHERE id = ?3 AND cart_id = ?4",
        [patch.qty, ts, lineId, cartId],
      );
      if (r.rowCount === 0) return null;
      var row = (await query("SELECT * FROM cart_lines WHERE id = ?1 AND cart_id = ?2", [lineId, cartId])).rows[0];
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, cartId]);
      return row;
    },

    // Same cart-scoping as updateLine: a row only deletes when it
    // belongs to the caller's session cart, so a cross-cart id is a
    // no-op (returns false) rather than deleting another visitor's line.
    removeLine: async function (lineId, cartId) {
      _uuid(lineId, "line id");
      _uuid(cartId, "cart_id");
      var row = (await query(
        "SELECT cart_id FROM cart_lines WHERE id = ?1 AND cart_id = ?2",
        [lineId, cartId],
      )).rows[0];
      if (!row) return false;
      await query("DELETE FROM cart_lines WHERE id = ?1 AND cart_id = ?2", [lineId, cartId]);
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [_now(), cartId]);
      return true;
    },

    // Customer login flow: merge an anonymous cart's lines into the
    // customer's existing active cart, then mark the anonymous cart
    // abandoned. Lines that collide on variant_id sum qty. The
    // returned cart is the surviving (customer's) cart.
    merge: async function (fromCartId, toCartId) {
      _uuid(fromCartId, "from cart_id");
      _uuid(toCartId,   "to cart_id");
      if (fromCartId === toCartId) throw new TypeError("cart.merge: fromCartId === toCartId");
      var fromLines = (await query("SELECT * FROM cart_lines WHERE cart_id = ?1", [fromCartId])).rows;
      var ts = _now();
      for (var i = 0; i < fromLines.length; i += 1) {
        var l = fromLines[i];
        var existing = (await query(
          "SELECT * FROM cart_lines WHERE cart_id = ?1 AND variant_id = ?2",
          [toCartId, l.variant_id],
        )).rows[0];
        if (existing) {
          var newQty = Math.min(existing.qty + l.qty, MAX_QTY);
          await query(
            "UPDATE cart_lines SET qty = ?1, updated_at = ?2 WHERE id = ?3",
            [newQty, ts, existing.id],
          );
        } else {
          var newId = b.uuid.v7();
          await query(
            "INSERT INTO cart_lines (id, cart_id, variant_id, sku, qty, unit_amount_minor, unit_currency, added_at, updated_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            [newId, toCartId, l.variant_id, l.sku, l.qty, l.unit_amount_minor, l.unit_currency, ts],
          );
        }
      }
      await query("UPDATE carts SET status = 'abandoned', updated_at = ?1 WHERE id = ?2", [ts, fromCartId]);
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, toCartId]);
      return (await query("SELECT * FROM carts WHERE id = ?1", [toCartId])).rows[0];
    },

    setCustomer: async function (cartId, customerId) {
      _uuid(cartId,    "cart_id");
      _uuid(customerId, "customer_id");
      var ts = _now();
      var r = await query(
        "UPDATE carts SET customer_id = ?1, updated_at = ?2 WHERE id = ?3",
        [customerId, ts, cartId],
      );
      if (r.rowCount === 0) return null;
      return (await query("SELECT * FROM carts WHERE id = ?1", [cartId])).rows[0];
    },

    setStatus: async function (cartId, status) {
      _uuid(cartId, "cart_id");
      _status(status);
      var ts = _now();
      var r = await query(
        "UPDATE carts SET status = ?1, updated_at = ?2 WHERE id = ?3",
        [status, ts, cartId],
      );
      if (r.rowCount === 0) return null;
      return (await query("SELECT * FROM carts WHERE id = ?1", [cartId])).rows[0];
    },
  };
}

module.exports = {
  create:           create,
  DEFAULT_TTL_MS:   DEFAULT_TTL_MS,
  MAX_QTY:          MAX_QTY,
  CART_STATUSES:    CART_STATUSES,
};
