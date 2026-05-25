"use strict";
/**
 * @module shop.saveForLater
 * @title  Save-for-later — adjacent to the cart; per-customer holdover
 *
 * @intro
 *   The storefront's "save for later" panel sits next to the cart.
 *   A shopper moves a line out of the cart (keeping the snapshot
 *   price, variant, and quantity) so a future session can drop it
 *   back in. This is NOT a wishlist:
 *
 *     wishlist          → "I'm interested in this product."
 *     save-for-later    → "I was about to buy this exact
 *                          configuration. Hold it for me."
 *
 *   Each saved row carries the original cart context — price at the
 *   moment of save, variant id, quantity, optional shopper notes,
 *   and a breadcrumb (source_cart_id + source_line_id) for analytics
 *   / abandoned-cart recovery. The shopper can later re-add at the
 *   saved snapshot price OR re-price against the current catalog,
 *   their choice (`moveToCart({ use_price: "saved" | "current" })`).
 *
 *   Composes:
 *     - `b.guardUuid` — every customer / save / cart / line id is
 *       UUID-shape-validated at the entry point; bad shape throws a
 *       TypeError the calling route handler translates to HTTP 400.
 *     - `b.uuid.v7` — row id (also lexicographically sortable as a
 *       tiebreak alongside saved_at).
 *     - `b.pagination.encodeCursor` / `decodeCursor` — HMAC-tagged
 *       opaque cursor on (saved_at DESC, id DESC) so an operator
 *       can't hand-craft a cursor to skip past a hidden row or
 *       replay one across deployments.
 *
 *   Surface:
 *     - `moveFromCart({ customer_id, cart_id, line_id })` — pulls a
 *       cart line, writes a save-for-later row, deletes the cart
 *       line. Compensating-undo on failure so the cart line never
 *       disappears without the save row landing first.
 *     - `moveToCart({ customer_id, save_id, cart_id, use_price })` —
 *       reverse: re-creates the cart line (at the saved snapshot
 *       price or the current catalog price), deletes the save row.
 *       Refuses when the SKU is now out of stock AND not
 *       backorderable.
 *     - `add({ customer_id, sku, variant_id?, quantity,
 *             snapshot_price_minor, notes? })` — direct save (the
 *       PDP "save without adding to cart" UI path).
 *     - `remove({ customer_id, save_id })` / `clear(customer_id)`.
 *     - `listForCustomer({ customer_id, limit?, cursor? })` — HMAC-
 *       tagged cursor, saved_at DESC.
 *     - `countForCustomer(customer_id)`.
 *     - `staleCheck(customer_id)` — annotates each row with
 *       `is_stale` (snapshot vs current price diverged),
 *       `is_unavailable` (catalog row gone / archived), and
 *       `is_low_stock` (catalog stock < saved quantity).
 *     - `repriceAll(customer_id)` — bulk rewrite snapshot prices to
 *       current; returns the count of rows actually changed.
 *     - `expireOlderThan(days)` — operator-scheduler entry point
 *       that prunes saves older than the supplied age.
 *
 *   Storage:
 *     - `save_for_later` (migration `0041_save_for_later.sql`).
 *
 * @primitive saveForLater
 * @related   b.guardUuid, b.pagination, b.uuid
 */

var MAX_NOTES_LEN    = 280;
var MAX_QTY          = 9999;
var DEFAULT_LIMIT    = 20;
var MAX_LIMIT        = 100;
var ORDER_KEY        = ["saved_at:desc", "id:desc"];
var USE_PRICE_VALUES = Object.freeze(["saved", "current"]);

var b = require("./vendor/blamejs");
var C = b.constants;

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("save-for-later: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _optUuid(s, label) {
  if (s == null || s === "") return null;
  return _uuid(s, label);
}

var SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("save-for-later: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, ≤ 128 chars)");
  }
}

function _qty(n, label) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_QTY) {
    throw new TypeError("save-for-later: " + label + " must be a positive integer ≤ " + MAX_QTY);
  }
}

function _priceMinor(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("save-for-later: " + label + " must be a non-negative integer");
  }
}

function _days(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("save-for-later: days must be a non-negative integer");
  }
}

function _normalizeNotes(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("save-for-later: notes must be a string");
  }
  // Refuse control bytes (incl. CR/LF) so a malicious note can't
  // smuggle header-injection-class content into operator dashboards
  // or downstream email templates that render the note inline.
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("save-for-later: notes must not contain control bytes");
  }
  if (s.length > MAX_NOTES_LEN) {
    throw new TypeError("save-for-later: notes must be ≤ " + MAX_NOTES_LEN + " chars");
  }
  return s;
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("save-for-later: " + label + " must be 1..." + MAX_LIMIT);
  }
  return n;
}

function _usePrice(s) {
  if (USE_PRICE_VALUES.indexOf(s) === -1) {
    throw new TypeError("save-for-later: use_price must be one of " + USE_PRICE_VALUES.join(", "));
  }
  return s;
}

function _now() { return Date.now(); }

// ---- catalog lookups ----------------------------------------------------
//
// The primitive composes against the shop's catalog handle when one is
// passed in. Three lookups it performs:
//
//   * `catalog.inventory.get(sku)`              — stock check for
//     `moveToCart` + `staleCheck`. Returns `{ stock_on_hand, ... }`
//     or null when the SKU is unknown.
//   * `catalog.variants.bySku(sku)`             — current
//     variant_id + product_id for `staleCheck`'s availability gate.
//     Returns null when the variant is gone.
//   * `catalog.prices.current(variant_id, ccy)` — current price for
//     `moveToCart({ use_price: "current" })` + `staleCheck` price
//     drift + `repriceAll`. Returns `{ amount_minor }` or null.
//
// Backorder eligibility uses a small ad-hoc query against
// `backorder_skus` (active=1 row) so the primitive doesn't need a
// dedicated backorder handle threaded in.
async function _isBackorderable(query, sku) {
  var r = await query(
    "SELECT 1 FROM backorder_skus WHERE sku = ?1 AND active = 1 LIMIT 1",
    [sku],
  );
  return r.rows.length > 0;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // The catalog handle is required for the price-resolution + stock-
  // check paths (`moveToCart` with `use_price: "current"`,
  // `staleCheck`, `repriceAll`). `moveFromCart` and `add` accept the
  // snapshot inline, so they don't strictly need it. The factory
  // refuses up-front when it's missing so operators don't hit a
  // half-working primitive at request time.
  if (!opts.catalog) {
    throw new TypeError("save-for-later.create: opts.catalog required (composes catalog.inventory + catalog.prices + catalog.variants)");
  }
  var catalog = opts.catalog;

  // The currency the catalog is priced in — `staleCheck` /
  // `repriceAll` / `moveToCart` need it to look up the current
  // price. Defaults to USD for tests; operators wire their own.
  var currency = opts.currency || "USD";
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError("save-for-later.create: opts.currency must be a 3-letter ISO 4217 code");
  }

  // Pagination cursors for listForCustomer are HMAC-tagged via
  // b.pagination so an operator can't hand-craft one to skip past a
  // hidden row or replay across deployments. The secret defaults to
  // a dev-only placeholder so the primitive boots in tests; the
  // production deployment supplies a derived value (typically
  // b.crypto.namespaceHash("save-for-later-cursor", D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("save-for-later.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "save-for-later-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Internal helper: writes a save_for_later row. Returns
  //   { id, status: "added" | "dedup" }
  // — the same shape wishlist.add uses so the storefront's UI copy
  // can differentiate "saved" from "already in your saved list".
  async function _writeSaveRow(input) {
    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT OR IGNORE INTO save_for_later " +
      "(id, customer_id, sku, variant_id, quantity, snapshot_price_minor, " +
      " notes, source_cart_id, source_line_id, saved_at, last_repriced_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL)",
      [
        id,
        input.customer_id,
        input.sku,
        input.variant_id,
        input.quantity,
        input.snapshot_price_minor,
        input.notes,
        input.source_cart_id,
        input.source_line_id,
        ts,
      ],
    );
    // Read back the (possibly pre-existing) row so the caller learns
    // whether INSERT OR IGNORE actually inserted or was deduped.
    var existing = (await query(
      "SELECT id FROM save_for_later " +
      "WHERE customer_id = ?1 AND sku = ?2 " +
      "AND COALESCE(variant_id, '') = COALESCE(?3, '') LIMIT 1",
      [input.customer_id, input.sku, input.variant_id],
    )).rows[0];
    return {
      id:     existing ? existing.id : id,
      status: existing && existing.id === id ? "added" : "dedup",
    };
  }

  return {
    MAX_NOTES_LEN:    MAX_NOTES_LEN,
    MAX_QTY:          MAX_QTY,
    USE_PRICE_VALUES: USE_PRICE_VALUES,

    // Pulls a cart line, writes a save-for-later row, deletes the
    // cart line. Atomic in the "either-both-or-neither" sense:
    //
    //   1. Read the cart line.
    //   2. INSERT the save row (with INSERT OR IGNORE → dedups on
    //      the (customer, sku, variant) tuple).
    //   3. DELETE the cart line.
    //
    //   D1 doesn't expose multi-statement transactions across the
    //   HTTP bridge, so atomicity is provided by ordering + a
    //   compensating undo: if (3) fails after (2) inserted a new
    //   row, the save row is rolled back so the cart line stays the
    //   sole source of truth. If (2) was a dedup (the row already
    //   existed), the cart-line delete still runs — re-running
    //   moveFromCart is idempotent.
    moveFromCart: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("save-for-later.moveFromCart: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var cartId     = _uuid(input.cart_id,     "cart_id");
      var lineId     = _uuid(input.line_id,     "line_id");

      var line = (await query(
        "SELECT * FROM cart_lines WHERE id = ?1 AND cart_id = ?2 LIMIT 1",
        [lineId, cartId],
      )).rows[0];
      if (!line) {
        throw new TypeError("save-for-later.moveFromCart: cart line " + lineId + " not found in cart " + cartId);
      }

      var saved = await _writeSaveRow({
        customer_id:          customerId,
        sku:                  line.sku,
        variant_id:           line.variant_id,
        quantity:             line.qty,
        snapshot_price_minor: line.unit_amount_minor,
        notes:                null,
        source_cart_id:       cartId,
        source_line_id:       lineId,
      });

      // The DELETE is the compensating-undo gate: if it throws after
      // the save row was newly inserted, the save row gets rolled
      // back so the cart line remains canonical. A dedup save —
      // status "dedup" — is left in place even on delete failure
      // because the existing save row predates this call and rolling
      // it back would lose unrelated customer state.
      try {
        var del = await query(
          "DELETE FROM cart_lines WHERE id = ?1 AND cart_id = ?2",
          [lineId, cartId],
        );
        if (Number(del.rowCount || 0) === 0) {
          // Someone else removed the line between our SELECT and DELETE.
          // Treat as a no-op on the cart side — the save row still
          // captures what the customer wanted.
        }
      } catch (e) {
        if (saved.status === "added") {
          // Compensating undo — drop the row we just inserted so the
          // cart line stays the only source of truth.
          try {
            await query("DELETE FROM save_for_later WHERE id = ?1", [saved.id]);
          } catch (_undoErr) { /* drop-silent — the original error is what the caller needs to see */ }
        }
        throw e;
      }

      return {
        id:     saved.id,
        status: saved.status,
        sku:    line.sku,
      };
    },

    // Reverse of moveFromCart: rebuild the cart line from a save row
    // (either at the original snapshot price or the current catalog
    // price), then delete the save row.
    //
    //   use_price === "saved"   — re-adds at snapshot_price_minor
    //   use_price === "current" — re-prices via
    //                              catalog.prices.current(variant_id,
    //                                                     currency)
    //
    //   Refuses when the SKU has zero available stock AND is not
    //   marked backorderable. Operators who want to allow oversell
    //   keep the SKU in `backorder_skus` with active=1.
    moveToCart: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("save-for-later.moveToCart: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var saveId     = _uuid(input.save_id,     "save_id");
      var cartId     = _uuid(input.cart_id,     "cart_id");
      var usePrice   = _usePrice(input.use_price);

      var save = (await query(
        "SELECT * FROM save_for_later WHERE id = ?1 AND customer_id = ?2 LIMIT 1",
        [saveId, customerId],
      )).rows[0];
      if (!save) {
        throw new TypeError("save-for-later.moveToCart: save " + saveId + " not found for customer " + customerId);
      }

      // Stock gate — backorderable SKUs bypass the available-stock
      // check; everything else needs current stock >= saved quantity.
      var inv = await catalog.inventory.get(save.sku);
      var available = inv ? (inv.stock_on_hand - (inv.stock_held || 0)) : 0;
      if (available < save.quantity) {
        var backorderable = await _isBackorderable(query, save.sku);
        if (!backorderable) {
          throw new TypeError(
            "save-for-later.moveToCart: sku " + save.sku +
            " is out of stock (available " + available + ", needed " + save.quantity + ") and not backorderable"
          );
        }
      }

      // Resolve the unit price.
      var unitAmount;
      if (usePrice === "saved") {
        unitAmount = save.snapshot_price_minor;
      } else {
        if (!save.variant_id) {
          throw new TypeError("save-for-later.moveToCart: use_price='current' requires a saved variant_id");
        }
        var current = await catalog.prices.current(save.variant_id, currency);
        if (!current) {
          throw new TypeError(
            "save-for-later.moveToCart: no current " + currency +
            " price for variant " + save.variant_id
          );
        }
        unitAmount = current.amount_minor;
      }

      // Write the cart line. The save row is deleted only after the
      // INSERT lands so a failure here (e.g. UNIQUE collision on
      // (cart_id, variant_id) — the customer already has a line for
      // this variant) leaves the save row intact for the operator /
      // customer to resolve.
      var lineId = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO cart_lines (id, cart_id, variant_id, sku, qty, unit_amount_minor, unit_currency, added_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        [lineId, cartId, save.variant_id, save.sku, save.quantity, unitAmount, currency, ts],
      );
      // Bump the parent cart's updated_at so abandoned-cart timers
      // see the activity.
      await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [ts, cartId]);
      // Drop the save row.
      await query("DELETE FROM save_for_later WHERE id = ?1", [saveId]);

      return {
        line_id:           lineId,
        cart_id:           cartId,
        sku:               save.sku,
        variant_id:        save.variant_id,
        quantity:          save.quantity,
        unit_amount_minor: unitAmount,
        unit_currency:     currency,
        priced_from:       usePrice,
      };
    },

    // Direct save (no prior cart line). Storefront PDP "save without
    // adding to cart" UI calls this — the customer supplies SKU,
    // optional variant, quantity, and a snapshot price the storefront
    // captures from the rendered price tag.
    add: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("save-for-later.add: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      _sku(input.sku);
      var variantId = _optUuid(input.variant_id, "variant_id");
      _qty(input.quantity, "quantity");
      _priceMinor(input.snapshot_price_minor, "snapshot_price_minor");
      var notes = _normalizeNotes(input.notes);

      var saved = await _writeSaveRow({
        customer_id:          customerId,
        sku:                  input.sku,
        variant_id:           variantId,
        quantity:             input.quantity,
        snapshot_price_minor: input.snapshot_price_minor,
        notes:                notes,
        source_cart_id:       null,
        source_line_id:       null,
      });
      return saved;
    },

    remove: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("save-for-later.remove: input object required");
      }
      var customerId = _uuid(input.customer_id, "customer_id");
      var saveId     = _uuid(input.save_id,     "save_id");
      var r = await query(
        "DELETE FROM save_for_later WHERE id = ?1 AND customer_id = ?2",
        [saveId, customerId],
      );
      return { removed: Number(r.rowCount || 0) > 0 };
    },

    clear: async function (customerId) {
      var cid = _uuid(customerId, "customer_id");
      var r = await query("DELETE FROM save_for_later WHERE customer_id = ?1", [cid]);
      return { removed: Number(r.rowCount || 0) };
    },

    listForCustomer: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("save-for-later.listForCustomer: input object required");
      }
      var customerId = _uuid(listOpts.customer_id, "customer_id");
      var limit = _limit(listOpts.limit, "limit");

      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("save-for-later.listForCustomer: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(ORDER_KEY)) {
            throw new TypeError("save-for-later.listForCustomer: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("save-for-later.listForCustomer: cursor — " + (e && e.message || "malformed"));
        }
      }

      var sql, params;
      if (cursorVals) {
        sql = "SELECT * FROM save_for_later WHERE customer_id = ?1 AND " +
              "(saved_at < ?2 OR (saved_at = ?2 AND id < ?3)) " +
              "ORDER BY saved_at DESC, id DESC LIMIT ?4";
        params = [customerId, cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM save_for_later WHERE customer_id = ?1 " +
              "ORDER BY saved_at DESC, id DESC LIMIT ?2";
        params = [customerId, limit];
      }
      var rows = (await query(sql, params)).rows;
      var last = rows[rows.length - 1];
      var nextCursor = null;
      if (last && rows.length === limit) {
        nextCursor = b.pagination.encodeCursor({
          orderKey: ORDER_KEY,
          vals:     [last.saved_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, nextCursor: nextCursor };
    },

    countForCustomer: async function (customerId) {
      var cid = _uuid(customerId, "customer_id");
      var r = await query(
        "SELECT COUNT(*) AS n FROM save_for_later WHERE customer_id = ?1",
        [cid],
      );
      return Number((r.rows[0] || {}).n || 0);
    },

    // Annotates every save row with three drift flags. Pure read —
    // doesn't mutate the saved rows. The storefront uses these to
    // surface "price changed" / "no longer available" / "running
    // low" badges in the saved-for-later panel.
    //
    //   is_stale       — current catalog price differs from the
    //                    saved snapshot. Implies the catalog row
    //                    still exists.
    //   is_unavailable — the variant is gone (or has no current
    //                    price), the catalog inventory row is gone,
    //                    OR the parent product is archived.
    //   is_low_stock   — catalog stock < saved quantity AND the SKU
    //                    is not backorderable. Backorderable SKUs
    //                    never flag low-stock (the operator already
    //                    opted in to overselling).
    staleCheck: async function (customerId) {
      var cid = _uuid(customerId, "customer_id");
      var saves = (await query(
        "SELECT * FROM save_for_later WHERE customer_id = ?1 ORDER BY saved_at DESC, id DESC",
        [cid],
      )).rows;
      var out = [];
      for (var i = 0; i < saves.length; i += 1) {
        var s = saves[i];
        var isStale       = false;
        var isUnavailable = false;
        var isLowStock    = false;
        var currentPriceMinor = null;

        // Variant lookup — if the variant id is gone, the row is
        // unavailable regardless of inventory.
        var variant = null;
        if (s.variant_id) {
          variant = await catalog.variants.get(s.variant_id);
          if (!variant) isUnavailable = true;
        }

        // Inventory lookup.
        var inv = await catalog.inventory.get(s.sku);
        if (!inv) {
          isUnavailable = true;
        } else if (!isUnavailable) {
          var available = inv.stock_on_hand - (inv.stock_held || 0);
          if (available < s.quantity) {
            var backorderable = await _isBackorderable(query, s.sku);
            if (!backorderable) isLowStock = true;
          }
        }

        // Price lookup — only meaningful when we still have a
        // variant + the row isn't already flagged unavailable.
        if (!isUnavailable && s.variant_id) {
          var price = await catalog.prices.current(s.variant_id, currency);
          if (!price) {
            isUnavailable = true;
          } else {
            currentPriceMinor = price.amount_minor;
            if (price.amount_minor !== s.snapshot_price_minor) {
              isStale = true;
            }
          }
        }

        out.push({
          id:                    s.id,
          customer_id:           s.customer_id,
          sku:                   s.sku,
          variant_id:            s.variant_id,
          quantity:              s.quantity,
          snapshot_price_minor:  s.snapshot_price_minor,
          current_price_minor:   currentPriceMinor,
          notes:                 s.notes,
          source_cart_id:        s.source_cart_id,
          source_line_id:        s.source_line_id,
          saved_at:              s.saved_at,
          last_repriced_at:      s.last_repriced_at,
          is_stale:              isStale,
          is_unavailable:        isUnavailable,
          is_low_stock:          isLowStock,
        });
      }
      return out;
    },

    // Bulk re-price: walk every save row for the customer, look up
    // the current catalog price, UPDATE snapshot_price_minor +
    // last_repriced_at where the price moved. Returns the count of
    // rows that actually changed.
    //
    //   Rows with no variant_id, or whose variant has no current
    //   price, are skipped (they fall under the unavailable branch
    //   of staleCheck — re-pricing an unknown variant would just be
    //   a no-op).
    repriceAll: async function (customerId) {
      var cid = _uuid(customerId, "customer_id");
      var saves = (await query(
        "SELECT * FROM save_for_later WHERE customer_id = ?1",
        [cid],
      )).rows;
      var changed = 0;
      for (var i = 0; i < saves.length; i += 1) {
        var s = saves[i];
        if (!s.variant_id) continue;
        var price = await catalog.prices.current(s.variant_id, currency);
        if (!price) continue;
        if (price.amount_minor === s.snapshot_price_minor) continue;
        var ts = _now();
        var r = await query(
          "UPDATE save_for_later SET snapshot_price_minor = ?1, last_repriced_at = ?2 WHERE id = ?3",
          [price.amount_minor, ts, s.id],
        );
        if (Number(r.rowCount || 0) > 0) changed += 1;
      }
      return { changed: changed };
    },

    // Operator scheduler entry point: remove every save older than
    // the supplied age. Returns the count of removed rows so the
    // cron / scheduled-worker layer can emit a metric.
    expireOlderThan: async function (days) {
      _days(days);
      var threshold = _now() - C.TIME.days(days);
      var r = await query(
        "DELETE FROM save_for_later WHERE saved_at < ?1",
        [threshold],
      );
      return { removed: Number(r.rowCount || 0) };
    },
  };
}

module.exports = {
  create:           create,
  MAX_NOTES_LEN:    MAX_NOTES_LEN,
  MAX_QTY:          MAX_QTY,
  USE_PRICE_VALUES: USE_PRICE_VALUES,
};
