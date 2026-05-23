"use strict";
/**
 * @module shop.inventoryAllocations
 * @title  Inventory allocations — soft-reserve holds for in-progress carts
 *
 * @intro
 *   `inventoryLocations` owns the committed shelf — every row in
 *   `inventory_stock` is real, claimable inventory. The gap that
 *   opens during checkout is the in-progress cart: the shopper has
 *   selected N units of a SKU but hasn't paid yet. Without a holds
 *   layer, a second shopper hitting "add to cart" a moment later
 *   sees the same N units available, and one of the two has to be
 *   told at payment time the item is gone — the classic oversell.
 *
 *   This primitive is the holds layer. Each `holdForCart` call
 *   reserves quantity against (sku, location_code?) for a specific
 *   cart_id with a TTL. Reads that need "how many can I actually
 *   sell?" subtract the open-hold sum from the committed shelf via
 *   `availableForSku`. On checkout completion the hold converts to
 *   a real stock movement via `inventoryLocations.adjustStock` —
 *   this primitive never writes `inventory_stock` directly; it
 *   composes the locations primitive for every committed mutation.
 *
 *   Verbs:
 *     holdForCart         — open a hold for { cart_id, sku, variant_id?,
 *                           quantity, location_code?, ttl_seconds? }.
 *                           Refuses if the requested qty would drive
 *                           availableForSku below zero.
 *     releaseHold         — flip a single hold to `released` with an
 *                           operator-supplied reason.
 *     releaseAllForCart   — bulk-release every active hold for a cart
 *                           (the abandonment / cancel path).
 *     commitHold          — finalize the hold: composes
 *                           inventoryLocations.adjustStock to debit
 *                           the committed shelf, then flips the hold
 *                           to `committed` with the order_id.
 *     extendHold          — bump expires_at by additional TTL seconds
 *                           (the shopper went idle but is still on
 *                           the page).
 *     availableForSku     — committed total minus open-hold sum for
 *                           the SKU (optionally filtered by location).
 *     holdsForCart        — every hold (any status) for a cart_id —
 *                           audit + UI surface.
 *     cleanupExpiredHolds — walks rows with expires_at <= now and
 *                           status='held', flips them to `expired`.
 *                           Idempotent.
 *     metricsForSku       — aggregate hold activity for a SKU in a
 *                           time window: counts by status, total qty
 *                           held / released / committed / expired.
 *
 *   Composition:
 *     - inventoryLocations — required. The holds layer composes its
 *                            `adjustStock`, `stockForSku`, and
 *                            `getLocation` verbs. Refusing to wire
 *                            one through fails loud at boot.
 *     - b.uuid.v7          — hold-row PKs (sortable by insertion).
 *
 *   Three-tier input validation (use the discipline; don't write
 *   the labels): every public verb here is a defensive request-
 *   shape reader OR a config-time entry point. Both throw on bad
 *   input. No drop-silent hot-path sinks.
 *
 *   Monotonic clock: a per-factory monotonic timestamp ensures
 *   two holds opened against the same SKU in the same wall-clock
 *   millisecond carry strictly-increasing created_at values so
 *   the audit-by-time queries always order them deterministically.
 *   Forward-leaps when the wall clock outpaces the counter;
 *   otherwise bumps by 1ms.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var CART_ID_RE     = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var SKU_RE         = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var VARIANT_ID_RE  = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CODE_RE        = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var ORDER_ID_RE    = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var HOLD_ID_RE     = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
var REASON_RE      = /^[\S\s]{1,256}$/;
var DEFAULT_TTL    = 900;          // 15 minutes by default
var MAX_TTL        = 24 * 60 * 60; // 24h ceiling — anything longer is a usage-error smell
var MIN_TTL        = 1;

// ---- validators ---------------------------------------------------------

function _cartId(s) {
  if (typeof s !== "string" || !CART_ID_RE.test(s)) {
    throw new TypeError("inventory-allocations: cart_id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("inventory-allocations: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}
function _variantId(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !VARIANT_ID_RE.test(s)) {
    throw new TypeError("inventory-allocations: variant_id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars) or be omitted");
  }
  return s;
}
function _locationCode(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("inventory-allocations: location_code must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars) or be omitted");
  }
  return s;
}
function _orderId(s) {
  if (typeof s !== "string" || !ORDER_ID_RE.test(s)) {
    throw new TypeError("inventory-allocations: order_id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}
function _holdId(s) {
  if (typeof s !== "string" || !HOLD_ID_RE.test(s)) {
    throw new TypeError("inventory-allocations: hold_id must be a UUID");
  }
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("inventory-allocations: " + label + " must be a positive integer");
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("inventory-allocations: " + label + " must be a non-negative integer");
  }
}
function _ttlSeconds(n, label) {
  if (!Number.isInteger(n) || n < MIN_TTL || n > MAX_TTL) {
    throw new TypeError("inventory-allocations: " + (label || "ttl_seconds") +
      " must be an integer in " + MIN_TTL + ".." + MAX_TTL + " (got " + JSON.stringify(n) + ")");
  }
}
function _reason(s, label) {
  if (typeof s !== "string" || !REASON_RE.test(s) || s.length > 256) {
    throw new TypeError("inventory-allocations: " + (label || "reason") +
      " must be a non-empty string ≤ 256 chars");
  }
  return s;
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

function _shapeHold(row) {
  if (!row) return null;
  return {
    id:                  row.id,
    cart_id:             row.cart_id,
    sku:                 row.sku,
    variant_id:          row.variant_id == null ? null : row.variant_id,
    location_code:       row.location_code == null ? null : row.location_code,
    quantity:            Number(row.quantity),
    status:              row.status,
    ttl_seconds:         Number(row.ttl_seconds),
    expires_at:          Number(row.expires_at),
    committed_order_id:  row.committed_order_id == null ? null : row.committed_order_id,
    release_reason:      row.release_reason == null ? null : row.release_reason,
    created_at:          Number(row.created_at),
    released_at:         row.released_at  == null ? null : Number(row.released_at),
    committed_at:        row.committed_at == null ? null : Number(row.committed_at),
    expired_at:          row.expired_at   == null ? null : Number(row.expired_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  // The inventoryLocations primitive owns every commit-time mutation
  // on `inventory_stock` — the holds layer composes its adjustStock
  // / stockForSku / getLocation verbs. Refusing to wire one through
  // fails loud at boot rather than at first call.
  if (!opts.inventoryLocations ||
      typeof opts.inventoryLocations.adjustStock !== "function" ||
      typeof opts.inventoryLocations.stockForSku !== "function" ||
      typeof opts.inventoryLocations.getLocation !== "function") {
    throw new TypeError("inventory-allocations.create: opts.inventoryLocations with " +
      "adjustStock + stockForSku + getLocation is required");
  }
  var locations = opts.inventoryLocations;
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Per-factory monotonic clock. Two holds opened against the same
  // SKU in the same wall-clock millisecond would otherwise tie on
  // created_at and make audit-by-time queries non-deterministic.
  // Forward-leap when the wall clock outpaces the counter; otherwise
  // bump by 1ms so the sequence is strictly increasing per factory
  // instance.
  var _lastEventTs = 0;
  function _monotonicTs() {
    var wall = _now();
    if (wall > _lastEventTs) _lastEventTs = wall;
    else                     _lastEventTs += 1;
    return _lastEventTs;
  }

  async function _getHoldRow(holdId) {
    var r = await query("SELECT * FROM inventory_holds WHERE id = ?1", [holdId]);
    return r.rows[0] || null;
  }

  // Sum the qty of held rows for a SKU, optionally restricted to a
  // single location. Holds with NULL location_code count against
  // every location query (they're not pinned yet), matching the
  // pessimistic-safe rule: an un-pinned hold should subtract from
  // the answer to "can I sell at any location?"
  async function _sumHeldQty(sku, locationCode) {
    var sql, params;
    if (locationCode == null) {
      sql = "SELECT COALESCE(SUM(quantity), 0) AS total " +
            "FROM inventory_holds WHERE sku = ?1 AND status = 'held'";
      params = [sku];
    } else {
      sql = "SELECT COALESCE(SUM(quantity), 0) AS total " +
            "FROM inventory_holds WHERE sku = ?1 AND status = 'held' " +
            "AND (location_code = ?2 OR location_code IS NULL)";
      params = [sku, locationCode];
    }
    var r = await query(sql, params);
    return r.rows[0] ? Number(r.rows[0].total) : 0;
  }

  // ---- holdForCart -----------------------------------------------------

  async function holdForCart(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("inventory-allocations.holdForCart: input object required");
    }
    _cartId(input.cart_id);
    _sku(input.sku);
    var variantId    = _variantId(input.variant_id);
    var locationCode = _locationCode(input.location_code);
    _positiveInt(input.quantity, "quantity");
    var ttlSeconds = input.ttl_seconds == null ? DEFAULT_TTL : input.ttl_seconds;
    _ttlSeconds(ttlSeconds, "ttl_seconds");

    if (locationCode != null) {
      var loc = await locations.getLocation(locationCode);
      if (!loc) {
        throw new TypeError("inventory-allocations.holdForCart: location_code " +
          JSON.stringify(locationCode) + " not found");
      }
    }

    // Refuse if the new hold would drive availableForSku below zero.
    // The shelf snapshot + the current held sum are read in sequence
    // — at this layer the primitive accepts a small race window
    // (two concurrent factories could both see headroom and both
    // commit). Operators that need strict serializability run the
    // hold path under a per-SKU advisory lock at the request layer;
    // this primitive's contract is "best-effort soft reserve."
    var shelf = await locations.stockForSku(input.sku);
    var committed;
    if (locationCode == null) {
      committed = shelf.total;
    } else {
      committed = 0;
      for (var i = 0; i < shelf.by_location.length; i += 1) {
        if (shelf.by_location[i].code === locationCode) {
          committed = shelf.by_location[i].quantity;
          break;
        }
      }
    }
    var alreadyHeld = await _sumHeldQty(input.sku, locationCode);
    var available   = committed - alreadyHeld;
    if (input.quantity > available) {
      throw new TypeError("inventory-allocations.holdForCart: insufficient available stock for " +
        input.sku + " (need " + input.quantity + ", available " + available +
        " = committed " + committed + " - held " + alreadyHeld + ")");
    }

    var ts        = _monotonicTs();
    var expiresAt = ts + ttlSeconds * 1000;
    var id        = _b().uuid.v7();
    await query(
      "INSERT INTO inventory_holds (id, cart_id, sku, variant_id, location_code, quantity, " +
      "status, ttl_seconds, expires_at, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'held', ?7, ?8, ?9)",
      [id, input.cart_id, input.sku, variantId, locationCode, input.quantity,
        ttlSeconds, expiresAt, ts],
    );
    return _shapeHold(await _getHoldRow(id));
  }

  // ---- releaseHold -----------------------------------------------------

  async function releaseHold(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("inventory-allocations.releaseHold: input object required");
    }
    _holdId(input.hold_id);
    var reason = _reason(input.reason, "reason");

    var existing = await _getHoldRow(input.hold_id);
    if (!existing) {
      throw new TypeError("inventory-allocations.releaseHold: hold_id " +
        JSON.stringify(input.hold_id) + " not found");
    }
    if (existing.status !== "held") {
      throw new TypeError("inventory-allocations.releaseHold: hold is " + existing.status +
        ", expected 'held'");
    }

    var ts = _monotonicTs();
    await query(
      "UPDATE inventory_holds SET status = 'released', released_at = ?1, release_reason = ?2 " +
      "WHERE id = ?3 AND status = 'held'",
      [ts, reason, input.hold_id],
    );
    return _shapeHold(await _getHoldRow(input.hold_id));
  }

  // ---- releaseAllForCart -----------------------------------------------

  async function releaseAllForCart(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("inventory-allocations.releaseAllForCart: input object required");
    }
    _cartId(input.cart_id);
    var reason = _reason(input.reason, "reason");

    var ts = _monotonicTs();
    var r = await query(
      "UPDATE inventory_holds SET status = 'released', released_at = ?1, release_reason = ?2 " +
      "WHERE cart_id = ?3 AND status = 'held'",
      [ts, reason, input.cart_id],
    );
    return { cart_id: input.cart_id, released_count: r.rowCount };
  }

  // ---- commitHold ------------------------------------------------------

  async function commitHold(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("inventory-allocations.commitHold: input object required");
    }
    _holdId(input.hold_id);
    _orderId(input.order_id);

    var existing = await _getHoldRow(input.hold_id);
    if (!existing) {
      throw new TypeError("inventory-allocations.commitHold: hold_id " +
        JSON.stringify(input.hold_id) + " not found");
    }
    if (existing.status !== "held") {
      throw new TypeError("inventory-allocations.commitHold: hold is " + existing.status +
        ", expected 'held'");
    }

    // commitHold needs a concrete location to debit the shelf. A
    // hold opened with location_code=NULL must be pinned before
    // commit — the storefront / checkout flow decides which
    // location ships and re-opens a pinned hold (or the operator
    // adds a default-location override at the request layer).
    if (existing.location_code == null) {
      throw new TypeError("inventory-allocations.commitHold: hold " + existing.id +
        " has no location_code — pin a location before commit");
    }

    // Debit the committed shelf through inventoryLocations.adjustStock
    // FIRST. If the shelf write fails (insufficient stock, unknown
    // location), the hold row stays in 'held' status so a retry or
    // a manual release decides next. Only after the debit lands does
    // the hold flip to 'committed' — the audit trail then proves
    // the commit happened.
    await locations.adjustStock({
      sku:           existing.sku,
      location_code: existing.location_code,
      delta:         -existing.quantity,
      reason:        "hold-commit:" + existing.id + " order:" + input.order_id,
    });

    var ts = _monotonicTs();
    await query(
      "UPDATE inventory_holds SET status = 'committed', committed_at = ?1, " +
      "committed_order_id = ?2 WHERE id = ?3 AND status = 'held'",
      [ts, input.order_id, input.hold_id],
    );
    return _shapeHold(await _getHoldRow(input.hold_id));
  }

  // ---- extendHold ------------------------------------------------------

  async function extendHold(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("inventory-allocations.extendHold: input object required");
    }
    _holdId(input.hold_id);
    _positiveInt(input.additional_ttl_seconds, "additional_ttl_seconds");
    if (input.additional_ttl_seconds > MAX_TTL) {
      throw new TypeError("inventory-allocations.extendHold: additional_ttl_seconds must be ≤ " + MAX_TTL);
    }

    var existing = await _getHoldRow(input.hold_id);
    if (!existing) {
      throw new TypeError("inventory-allocations.extendHold: hold_id " +
        JSON.stringify(input.hold_id) + " not found");
    }
    if (existing.status !== "held") {
      throw new TypeError("inventory-allocations.extendHold: hold is " + existing.status +
        ", expected 'held'");
    }

    var nextExpires = Number(existing.expires_at) + input.additional_ttl_seconds * 1000;
    await query(
      "UPDATE inventory_holds SET expires_at = ?1 WHERE id = ?2 AND status = 'held'",
      [nextExpires, input.hold_id],
    );
    return _shapeHold(await _getHoldRow(input.hold_id));
  }

  // ---- availableForSku -------------------------------------------------

  async function availableForSku(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("inventory-allocations.availableForSku: input object required");
    }
    _sku(input.sku);
    var locationCode = _locationCode(input.location_code);

    var shelf = await locations.stockForSku(input.sku);
    var committed;
    if (locationCode == null) {
      committed = shelf.total;
    } else {
      committed = 0;
      for (var i = 0; i < shelf.by_location.length; i += 1) {
        if (shelf.by_location[i].code === locationCode) {
          committed = shelf.by_location[i].quantity;
          break;
        }
      }
    }
    var held      = await _sumHeldQty(input.sku, locationCode);
    var available = committed - held;
    if (available < 0) available = 0;
    return {
      sku:           input.sku,
      location_code: locationCode,
      committed:     committed,
      on_hold:       held,
      available:     available,
    };
  }

  // ---- holdsForCart ----------------------------------------------------

  async function holdsForCart(cartId) {
    _cartId(cartId);
    var r = await query(
      "SELECT * FROM inventory_holds WHERE cart_id = ?1 ORDER BY created_at ASC",
      [cartId],
    );
    return r.rows.map(_shapeHold);
  }

  // ---- cleanupExpiredHolds ---------------------------------------------

  async function cleanupExpiredHolds(input) {
    input = input || {};
    var now = input.now == null ? _now() : input.now;
    _nonNegInt(now, "now");

    var ts = _monotonicTs();
    if (ts < now) ts = now;        // forward-leap the monotonic to the supplied clock if needed
    var r = await query(
      "UPDATE inventory_holds SET status = 'expired', expired_at = ?1, " +
      "release_reason = 'ttl_expired' " +
      "WHERE status = 'held' AND expires_at <= ?2",
      [ts, now],
    );
    return { expired_count: r.rowCount };
  }

  // ---- metricsForSku ---------------------------------------------------

  async function metricsForSku(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("inventory-allocations.metricsForSku: input object required");
    }
    _sku(input.sku);
    _nonNegInt(input.from, "from");
    _nonNegInt(input.to,   "to");
    if (input.to < input.from) {
      throw new TypeError("inventory-allocations.metricsForSku: to must be ≥ from");
    }

    // Count + sum-qty per status. Window predicate matches the row
    // against the timestamp that corresponds to its current status:
    // 'held' uses created_at, terminal statuses use their respective
    // transition timestamp. This makes the metric semantically
    // honest — a hold that opened in the window but committed
    // outside it doesn't double-count.
    var r = await query(
      "SELECT status, COUNT(*) AS row_count, COALESCE(SUM(quantity), 0) AS qty_sum " +
      "FROM inventory_holds " +
      "WHERE sku = ?1 AND (" +
      "  (status = 'held'      AND created_at   BETWEEN ?2 AND ?3) OR " +
      "  (status = 'released'  AND released_at  BETWEEN ?2 AND ?3) OR " +
      "  (status = 'committed' AND committed_at BETWEEN ?2 AND ?3) OR " +
      "  (status = 'expired'   AND expired_at   BETWEEN ?2 AND ?3) " +
      ") " +
      "GROUP BY status",
      [input.sku, input.from, input.to],
    );

    var out = {
      sku:       input.sku,
      from:      input.from,
      to:        input.to,
      held:      { count: 0, quantity: 0 },
      released:  { count: 0, quantity: 0 },
      committed: { count: 0, quantity: 0 },
      expired:   { count: 0, quantity: 0 },
    };
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      if (out[row.status]) {
        out[row.status] = {
          count:    Number(row.row_count),
          quantity: Number(row.qty_sum),
        };
      }
    }
    return out;
  }

  return {
    holdForCart:         holdForCart,
    releaseHold:         releaseHold,
    releaseAllForCart:   releaseAllForCart,
    commitHold:          commitHold,
    extendHold:          extendHold,
    availableForSku:     availableForSku,
    holdsForCart:        holdsForCart,
    cleanupExpiredHolds: cleanupExpiredHolds,
    metricsForSku:       metricsForSku,
  };
}

module.exports = {
  create:      create,
  DEFAULT_TTL: DEFAULT_TTL,
  MAX_TTL:     MAX_TTL,
};
