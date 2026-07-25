"use strict";
/**
 * @module shop.backorder
 * @title  Backorder — out-of-stock SKUs that can still be ordered
 *
 * @intro
 *   The catalog's inventory bucket says "we have N units on the
 *   shelf". A backorderable SKU says "we don't have it on the shelf,
 *   but the operator commits to ship by <date>" — and the storefront
 *   PDP renders "Ships by <date>" instead of "Out of stock" so the
 *   customer can still complete the purchase.
 *
 *   Lifecycle:
 *
 *     markBackorderable({ sku, max_backorder_quantity?,
 *                          expected_ship_date, message? })
 *       → operator opts a SKU in. Upserts the per-SKU config row.
 *         `max_backorder_quantity: null` (or omitted) means
 *         unlimited; a positive integer caps the in-flight pending
 *         quantity so the operator doesn't commit beyond their
 *         supplier's capacity. `pending_quantity` is preserved across
 *         re-marks so re-marking the same SKU doesn't reset the
 *         counter.
 *
 *     markNotBackorderable(sku)
 *       → flips `active` to 0. The row is preserved so historical
 *         lines still resolve their config; future `availabilityFor`
 *         calls return `out_of_stock` once stock_on_hand is also 0.
 *
 *     recordBackorder({ order_id, sku, quantity, customer_id })
 *       → writes one `backorder_lines` row per backordered line at
 *         checkout time. Refuses if the SKU isn't currently
 *         backorderable, or if the requested quantity would push
 *         `pending_quantity` past the configured cap. Increments the
 *         per-SKU counter as part of the same logical operation.
 *         Idempotent on `(order_id, sku)` via the UNIQUE constraint —
 *         the same line replayed returns `{ status: "dedup" }` and
 *         does not double-increment the counter.
 *
 *     fulfillBackorder({ order_id, sku }) /
 *     cancelBackorder({ order_id, sku, reason })
 *       → flip the row to `fulfilled` / `cancelled` and decrement
 *         the counter. Refuse on missing row or non-pending status
 *         so the counter can never under-flow.
 *
 *     availabilityFor(sku) — pure read used by the PDP
 *       → returns one of:
 *           { status: "in_stock" }
 *           { status: "backorderable",
 *             expected_ship_date, message }
 *           { status: "out_of_stock" }
 *         Reads catalog inventory + the per-SKU backorder config;
 *         `in_stock` wins whenever stock_on_hand > 0 (the
 *         backorderable flag is irrelevant — fulfill from the shelf
 *         first).
 *
 *     customerBackorders(customer_id) /
 *     pendingForSku(sku) /
 *     arrivalsThisWeek()
 *       → operator + customer dashboard reads.
 *
 *   Composition:
 *     - b.guardUuid — every order_id / customer_id is UUID-shape
 *       validated at the entry point; SKU shape is validated via a
 *       local regex matching the rest of the shop primitives.
 *     - b.uuid.v7 — backorder_lines.id (sortable; customer dashboard
 *       reads sort by id desc to get newest-first without a second
 *       index).
 *     - catalog.inventory.get(sku) — the single source of truth for
 *       on-shelf stock. `availabilityFor` reads it but never mutates
 *       it; the catalog stays the owner of stock_on_hand.
 *
 *   The factory accepts an optional `query` (defaults to
 *   b.externalDb.query) and a required `catalog` handle so the
 *   primitive stays decoupled from any specific catalog binding —
 *   tests inject an in-memory-SQLite-backed catalog; production wires
 *   the real catalog created at boot.
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var SKU_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var MAX_MESSAGE_LEN = 280;
var MAX_REASON_LEN  = 280;
var WEEK_MS         = C.TIME.days(7);

var BACKORDER_STATUSES = Object.freeze(["pending", "fulfilled", "cancelled"]);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("backorder: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("backorder: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, ≤ 128 chars)");
  }
}

function _shortText(s, label, max) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > max) {
    throw new TypeError("backorder: " + label + " must be a string ≤ " + max + " chars");
  }
  return s;
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("backorder: " + label + " must be a positive integer");
  }
}

function _nonNegIntOrNull(n, label) {
  if (n === null || n === undefined) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("backorder: " + label + " must be a non-negative integer or null");
  }
  return n;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("backorder: " + label + " must be a non-negative integer (epoch ms)");
  }
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.catalog || !opts.catalog.inventory || typeof opts.catalog.inventory.get !== "function") {
    throw new TypeError("backorder.create: opts.catalog with inventory.get(sku) required");
  }
  var catalog = opts.catalog;
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Read the per-SKU config row. Returns null on miss so callers can
  // map cleanly to the "not configured" branch without an exception
  // round-trip.
  async function _getConfig(sku) {
    var r = await query("SELECT * FROM backorder_skus WHERE sku = ?1", [sku]);
    return r.rows[0] || null;
  }

  return {
    // Operator opts a SKU in. Upserts the config row so re-marking
    // updates expected_ship_date / message / cap without resetting
    // the counter. `max_backorder_quantity: null` (or omitted) means
    // unlimited — operators that want a strict cap pass a positive
    // integer; passing 0 means "no new backorders accepted" (the
    // existing pending rows remain).
    markBackorderable: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("backorder.markBackorderable: input object required");
      }
      _sku(input.sku);
      var max = _nonNegIntOrNull(input.max_backorder_quantity, "max_backorder_quantity");
      _epochMs(input.expected_ship_date, "expected_ship_date");
      var message = _shortText(input.message, "message", MAX_MESSAGE_LEN);
      var ts = _now();
      var existing = await _getConfig(input.sku);
      if (!existing) {
        await query(
          "INSERT INTO backorder_skus (sku, max_quantity, expected_ship_date, message, " +
          "pending_quantity, active, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, 0, 1, ?5, ?5)",
          [input.sku, max, input.expected_ship_date, message, ts],
        );
      } else {
        await query(
          "UPDATE backorder_skus SET max_quantity = ?1, expected_ship_date = ?2, " +
          "message = ?3, active = 1, updated_at = ?4 WHERE sku = ?5",
          [max, input.expected_ship_date, message, ts, input.sku],
        );
      }
      return await _getConfig(input.sku);
    },

    // Flip a SKU's backorder config off. The row is preserved so the
    // pending_quantity counter + historical line resolution still
    // work; future availabilityFor calls fall through to in_stock /
    // out_of_stock without the backorderable branch.
    markNotBackorderable: async function (sku) {
      _sku(sku);
      var ts = _now();
      var r = await query(
        "UPDATE backorder_skus SET active = 0, updated_at = ?1 WHERE sku = ?2",
        [ts, sku],
      );
      if (r.rowCount === 0) return null;
      return await _getConfig(sku);
    },

    getStatus: async function (sku) {
      _sku(sku);
      return await _getConfig(sku);
    },

    listBackorderable: async function (listOpts) {
      listOpts = listOpts || {};
      var activeOnly = listOpts.active_only === true;
      var sql, params;
      if (activeOnly) {
        sql = "SELECT * FROM backorder_skus WHERE active = 1 ORDER BY expected_ship_date ASC, sku ASC";
        params = [];
      } else {
        sql = "SELECT * FROM backorder_skus ORDER BY expected_ship_date ASC, sku ASC";
        params = [];
      }
      var r = await query(sql, params);
      return r.rows;
    },

    // Record one backorder line at checkout time. Refuses if:
    //   - the SKU isn't currently backorderable (no config / active=0)
    //   - the quantity would push pending_quantity past max_quantity
    // Idempotent on (order_id, sku) via the UNIQUE constraint — the
    // same line replayed returns { status: 'dedup' } and does not
    // double-increment the counter.
    recordBackorder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("backorder.recordBackorder: input object required");
      }
      _uuid(input.order_id,    "order_id");
      _uuid(input.customer_id, "customer_id");
      _sku(input.sku);
      _positiveInt(input.quantity, "quantity");

      // Idempotency — same (order_id, sku) returns dedup without
      // mutating the counter. The UNIQUE constraint backstops a race
      // window where two callers raced past the SELECT below. Dedup
      // is checked BEFORE the cap so a replay of an already-recorded
      // line doesn't trip the cap refusal when the existing pending
      // total is at the cap.
      var dup = await query(
        "SELECT id, status FROM backorder_lines WHERE order_id = ?1 AND sku = ?2 LIMIT 1",
        [input.order_id, input.sku],
      );
      if (dup.rows.length) {
        return { id: dup.rows[0].id, status: "dedup", line_status: dup.rows[0].status };
      }

      var config = await _getConfig(input.sku);
      if (!config || config.active !== 1) {
        throw new TypeError("backorder.recordBackorder: sku " + JSON.stringify(input.sku) + " is not currently backorderable");
      }
      // Cap enforcement. NULL max_quantity = unlimited; a configured
      // cap refuses any line that would push the in-flight pending
      // total past it.
      if (config.max_quantity !== null && config.max_quantity !== undefined) {
        if (config.pending_quantity + input.quantity > config.max_quantity) {
          throw new TypeError("backorder.recordBackorder: would exceed max_backorder_quantity " +
            "(cap=" + config.max_quantity + ", pending=" + config.pending_quantity +
            ", requested=" + input.quantity + ")");
        }
      }

      var id = b.uuid.v7();
      var ts = _now();
      // Claim capacity FIRST, atomically, THEN create the line. The early
      // check above reads a snapshot; two concurrent calls can both pass it,
      // so the cap is folded into this guarded update — only an increment that
      // keeps pending within the cap (on an active sku) applies, gated on
      // rowCount. Claiming before the INSERT means a line only exists once its
      // capacity is committed: a concurrent retry's dedup check never sees a
      // line that a cap loss would then have to delete (which would let the
      // retry report a phantom success for a backorder that no longer exists).
      var claim = await query(
        "UPDATE backorder_skus SET pending_quantity = pending_quantity + ?1, updated_at = ?2 " +
        "WHERE sku = ?3 AND active = 1 AND (max_quantity IS NULL OR pending_quantity + ?1 <= max_quantity)",
        [input.quantity, ts, input.sku],
      );
      if (Number((claim && claim.rowCount) || 0) !== 1) {
        var cur = await _getConfig(input.sku);
        if (!cur || cur.active !== 1) {
          throw new TypeError("backorder.recordBackorder: sku " + JSON.stringify(input.sku) + " is not currently backorderable");
        }
        throw new TypeError("backorder.recordBackorder: would exceed max_backorder_quantity " +
          "(cap=" + cur.max_quantity + ", pending=" + cur.pending_quantity + ", requested=" + input.quantity + ")");
      }
      try {
        await query(
          "INSERT INTO backorder_lines (id, order_id, customer_id, sku, quantity, status, " +
          "created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)",
          [id, input.order_id, input.customer_id, input.sku, input.quantity, ts],
        );
      } catch (e) {
        // A concurrent call for the same (order_id, sku) already recorded the
        // line (UNIQUE violation) after we claimed capacity. Release the
        // capacity we just claimed so the line is counted exactly once, then
        // return the dedup shape (or re-raise a non-duplicate error).
        await query(
          "UPDATE backorder_skus SET pending_quantity = pending_quantity - ?1, updated_at = ?2 WHERE sku = ?3",
          [input.quantity, _now(), input.sku],
        );
        var redup = await query(
          "SELECT id, status FROM backorder_lines WHERE order_id = ?1 AND sku = ?2 LIMIT 1",
          [input.order_id, input.sku],
        );
        if (redup.rows.length) {
          return { id: redup.rows[0].id, status: "dedup", line_status: redup.rows[0].status };
        }
        throw e;
      }
      return { id: id, status: "recorded" };
    },

    // Flip a pending backorder line to fulfilled. Decrements the
    // per-SKU counter. Refuses on missing row or non-pending status
    // so the counter can never under-flow.
    fulfillBackorder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("backorder.fulfillBackorder: input object required");
      }
      _uuid(input.order_id, "order_id");
      _sku(input.sku);
      var r = await query(
        "SELECT id, quantity, status FROM backorder_lines WHERE order_id = ?1 AND sku = ?2 LIMIT 1",
        [input.order_id, input.sku],
      );
      if (!r.rows.length) {
        throw new TypeError("backorder.fulfillBackorder: no backorder line for order=" +
          input.order_id + " sku=" + JSON.stringify(input.sku));
      }
      var line = r.rows[0];
      if (line.status !== "pending") {
        throw new TypeError("backorder.fulfillBackorder: line is " + line.status +
          ", only pending lines can be fulfilled");
      }
      var ts = _now();
      // Atomic claim: gate on `status = 'pending'`. The JS check above
      // only refuses a sequential re-fulfill; two concurrent calls
      // would both pass it and both decrement the per-SKU counter for
      // one line (a double debit). Claiming the line first means the
      // counter is only debited by the caller that won the transition.
      var fulfillClaim = await query(
        "UPDATE backorder_lines SET status = 'fulfilled', fulfilled_at = ?1 " +
        "WHERE id = ?2 AND status = 'pending'",
        [ts, line.id],
      );
      if (!b.sql.casWon(fulfillClaim).won) {
        throw new TypeError("backorder.fulfillBackorder: line is no longer pending " +
          "(concurrently fulfilled or cancelled)");
      }
      // MAX(0, ...) clamps the counter so an out-of-band counter
      // corruption (operator hand-edited a row) can't drive it
      // negative. The CHECK constraint on pending_quantity would
      // otherwise refuse the UPDATE outright.
      await query(
        "UPDATE backorder_skus SET pending_quantity = MAX(0, pending_quantity - ?1), " +
        "updated_at = ?2 WHERE sku = ?3",
        [line.quantity, ts, input.sku],
      );
      return { id: line.id, status: "fulfilled" };
    },

    cancelBackorder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("backorder.cancelBackorder: input object required");
      }
      _uuid(input.order_id, "order_id");
      _sku(input.sku);
      var reason = _shortText(input.reason, "reason", MAX_REASON_LEN);
      var r = await query(
        "SELECT id, quantity, status FROM backorder_lines WHERE order_id = ?1 AND sku = ?2 LIMIT 1",
        [input.order_id, input.sku],
      );
      if (!r.rows.length) {
        throw new TypeError("backorder.cancelBackorder: no backorder line for order=" +
          input.order_id + " sku=" + JSON.stringify(input.sku));
      }
      var line = r.rows[0];
      if (line.status !== "pending") {
        throw new TypeError("backorder.cancelBackorder: line is " + line.status +
          ", only pending lines can be cancelled");
      }
      var ts = _now();
      // Atomic claim (see fulfillBackorder): gate on `status = 'pending'`
      // so a cancel racing a concurrent fulfill/cancel can't double-debit
      // the per-SKU counter for one line.
      var cancelClaim = await query(
        "UPDATE backorder_lines SET status = 'cancelled', reason = ?1, cancelled_at = ?2 " +
        "WHERE id = ?3 AND status = 'pending'",
        [reason, ts, line.id],
      );
      if (!b.sql.casWon(cancelClaim).won) {
        throw new TypeError("backorder.cancelBackorder: line is no longer pending " +
          "(concurrently fulfilled or cancelled)");
      }
      await query(
        "UPDATE backorder_skus SET pending_quantity = MAX(0, pending_quantity - ?1), " +
        "updated_at = ?2 WHERE sku = ?3",
        [line.quantity, ts, input.sku],
      );
      return { id: line.id, status: "cancelled" };
    },

    // Pure read used by the PDP. Resolution rules:
    //   1. stock_on_hand > 0           → in_stock (fulfill from shelf
    //                                     first; backorderable flag
    //                                     is irrelevant)
    //   2. config active=1 + stock = 0 → backorderable + ship date +
    //                                     message
    //   3. otherwise                   → out_of_stock
    // The cap is not enforced here — availabilityFor returns the
    // configured ship date even when the cap is full; the cap refusal
    // surfaces at recordBackorder time so the customer sees the same
    // PDP state until they actually try to commit.
    availabilityFor: async function (sku) {
      _sku(sku);
      var inv = await catalog.inventory.get(sku);
      var onHand = inv && inv.stock_on_hand != null ? inv.stock_on_hand : 0;
      if (onHand > 0) {
        return { status: "in_stock" };
      }
      var config = await _getConfig(sku);
      if (config && config.active === 1) {
        return {
          status:             "backorderable",
          expected_ship_date: config.expected_ship_date,
          message:            config.message,
        };
      }
      return { status: "out_of_stock" };
    },

    // Newest first — the customer's account page renders the most
    // recent backorder at the top. The v7-uuid PK sorts
    // lexicographically by creation order so `ORDER BY id DESC` is
    // equivalent to `ORDER BY created_at DESC` without needing the
    // separate timestamp index.
    customerBackorders: async function (customerId) {
      _uuid(customerId, "customer_id");
      var r = await query(
        "SELECT * FROM backorder_lines WHERE customer_id = ?1 ORDER BY id DESC",
        [customerId],
      );
      return r.rows;
    },

    pendingForSku: async function (sku) {
      _sku(sku);
      var r = await query(
        "SELECT * FROM backorder_lines WHERE sku = ?1 AND status = 'pending' ORDER BY id ASC",
        [sku],
      );
      return r.rows;
    },

    // Operator dashboard read — pending backorder lines whose
    // configured expected_ship_date falls in the next 7 days
    // (inclusive of now). The join pulls the per-SKU ship date so
    // operators don't have to fan out one read per sku.
    arrivalsThisWeek: async function () {
      var now = _now();
      var cutoff = now + WEEK_MS;
      var r = await query(
        "SELECT l.*, s.expected_ship_date AS expected_ship_date, s.message AS message " +
        "FROM backorder_lines l JOIN backorder_skus s ON s.sku = l.sku " +
        "WHERE l.status = 'pending' AND s.expected_ship_date <= ?1 " +
        "ORDER BY s.expected_ship_date ASC, l.id ASC",
        [cutoff],
      );
      return r.rows;
    },
  };
}

module.exports = {
  create:             create,
  BACKORDER_STATUSES: BACKORDER_STATUSES,
};
