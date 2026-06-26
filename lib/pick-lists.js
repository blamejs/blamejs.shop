"use strict";
/**
 * @module shop.pickLists
 * @title  Pick lists — warehouse fulfillment worksheet that consolidates
 *         N open orders into an aisle-sequenced picker route
 *
 * @intro
 *   Thirty orders just rolled in. Each one is a mix of two or three
 *   SKUs scattered across different aisles. A naive "pick each order
 *   in turn" walk has the picker criss-crossing the warehouse for
 *   half an hour. The fix is to consolidate the open orders into a
 *   single sequenced worksheet keyed by aisle position — the picker
 *   walks each aisle once, scans every SKU on the route, and the
 *   system stitches the picked qty back onto the parent orders.
 *
 *   Lifecycle (four-state FSM):
 *
 *     generateList({ location_code, order_ids?, max_lines?, sort_by? })
 *       Snapshots a set of open orders into a worksheet. `order_ids`
 *       is optional — when omitted, the primitive selects every
 *       `paid` / `fulfilling` order in `created_at` order up to
 *       `max_lines`. When supplied, the primitive validates each id
 *       and refuses unknown / terminal-state orders (cancelled /
 *       refunded). For every selected order, every order_line
 *       produces one pick_list_line row with the parent qty as
 *       `expected_quantity`. The `aisle_position` column is populated
 *       from the optional `inventoryLocations.binForSku(sku,
 *       location_code)` verb when wired, falling back to the sku
 *       itself (deterministic + sortable, no fabricated bin data).
 *       The row ordering at insert time matches `sort_by`:
 *         aisle    — walk-order across the warehouse (default)
 *         sku      — alphabetic SKU grouping (kit-pack workflows)
 *         priority — every line from order A, then every line from
 *                    order B (operator-supplied priority via order_id
 *                    array order)
 *         order_id — same as priority but with the lexicographic
 *                    order_id ordering when order_ids isn't supplied
 *       `max_lines` caps the total line count — once the cap is hit
 *       the remaining selected orders are skipped (the worksheet is
 *       a unit of picker work, not a queue; the operator generates
 *       another list for the next batch).
 *
 *     confirmLine({ list_id, line_id, picker_id, actual_quantity? })
 *       Stamps `actual_quantity` (defaults to `expected_quantity`
 *       when the line was picked clean), `picked_by`, `picked_at`
 *       on the line. Transitions the list generated -> in_progress
 *       on the first confirm. Idempotent on the per-line value —
 *       calling confirmLine twice overwrites the prior values (a
 *       recount). Refuses confirms once the list is complete or
 *       cancelled (the picker is supposed to call markListComplete
 *       once every line is settled; double-confirming after a
 *       shipment has already been created would leave an audit hole).
 *
 *     markListComplete({ list_id })
 *       in_progress -> complete. Refuses if any line still has
 *       actual_quantity = NULL (the picker hasn't settled every row
 *       — short-picks are settled by confirming with
 *       actual_quantity=0, not by leaving the column null). For
 *       every parent order represented on the list, calls
 *       `orderTracking.createShipment({ order_id, carrier: "other",
 *       carrier_other_name: "pickup", notes: "pick-list:<id>" })`
 *       once — the picked parcel has no carrier assigned yet, so it
 *       rides orderTracking's 'other' escape hatch labelled "pickup"
 *       until the operator records a real carrier against it. The
 *       shipment id is captured on the return value so the operator
 *       UI can deep-link to each generated shipment. Stamps
 *       `completed_at`.
 *
 *     cancelList({ list_id, reason })
 *       generated|in_progress -> cancelled. Persists the reason +
 *       cancelled_at. The list's lines are retained (the FK CASCADE
 *       is not invoked — operators still need the audit trail of
 *       partial picks against the original worksheet). Cancelling a
 *       complete list is refused — the shipments have already been
 *       created and the variance reconciliation has landed on the
 *       order ledger.
 *
 *   Reads:
 *     getList(list_id)                           — hydrated header + lines
 *     listLists({ location_code?, status? })     — filtered headers
 *     discrepanciesFor(list_id)                  — per-line short / over
 *                                                  picks (actual !=
 *                                                  expected) for the
 *                                                  operator's variance
 *                                                  report
 *
 *   Composition:
 *     - b.uuid.v7              — list / line PKs (sortable)
 *     - b.guardUuid            — strict UUID validation on every id
 *     - order                  — SOLE owner of the orders table read;
 *                                generateList composes `order.get(id)`
 *                                to fetch order_lines. Required.
 *     - orderTracking          — SOLE owner of shipment creation;
 *                                markListComplete composes
 *                                `orderTracking.createShipment(...)`
 *                                per parent order. Required.
 *     - inventoryLocations     — optional. When wired, the primitive
 *                                probes for `binForSku(sku,
 *                                location_code)` to populate the
 *                                aisle_position column. Falls back
 *                                to the sku itself when the verb is
 *                                absent so the dependency is
 *                                truly optional.
 *
 *   Three-tier input validation (use the discipline; don't write the
 *   labels): every public verb here is either a config-time entry
 *   point (factory create) or a defensive request-shape reader. All
 *   throw on bad input — no drop-silent hot-path sinks.
 *
 * @primitive pickLists
 * @related    order, orderTracking, inventoryLocations, splitShipments
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var CODE_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var PICKER_RE        = /^[\S\s]{1,128}$/;
var MAX_REASON       = 280;
var MAX_ORDER_IDS    = 500;
var DEFAULT_MAX_LINES = 250;
var MAX_LINES_CAP    = 2000;

var LIST_STATUSES    = Object.freeze(["generated", "in_progress", "complete", "cancelled"]);
var SORT_BY_ENUM     = Object.freeze(["aisle", "sku", "priority", "order_id"]);

// Orders eligible to be folded into a pick list. Pending orders
// haven't reached payment yet; shipped/delivered are past the
// picker's hands; refunded/cancelled are terminal-sad. Paid +
// fulfilling are the two states where the warehouse owes the
// customer a shipment.
var ELIGIBLE_ORDER_STATES = Object.freeze(["paid", "fulfilling"]);

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("pick-lists: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}
function _code(s, label) {
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("pick-lists: " + (label || "location_code") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
}
function _sortBy(s) {
  if (SORT_BY_ENUM.indexOf(s) === -1) {
    throw new TypeError("pick-lists: sort_by must be one of " + SORT_BY_ENUM.join(", ") +
      ", got " + JSON.stringify(s));
  }
}
function _status(s) {
  if (LIST_STATUSES.indexOf(s) === -1) {
    throw new TypeError("pick-lists: status must be one of " + LIST_STATUSES.join(", ") +
      ", got " + JSON.stringify(s));
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("pick-lists: " + label + " must be a non-negative integer");
  }
}
function _picker(s) {
  if (typeof s !== "string" || !PICKER_RE.test(s) || s.length > 128) {
    throw new TypeError("pick-lists: picker_id must be a non-empty string ≤ 128 chars");
  }
}
function _reason(s) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > MAX_REASON) {
    throw new TypeError("pick-lists: reason must be a string ≤ " + MAX_REASON + " chars");
  }
  return s;
}
function _maxLines(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LINES_CAP) {
    throw new TypeError("pick-lists: max_lines must be an integer in 1..." + MAX_LINES_CAP);
  }
}

// Monotonic clock — every write that stamps a timestamp uses _now()
// instead of Date.now() directly so a generateList + immediate
// confirmLine + markListComplete sequence never collides on the
// millisecond boundary. Operators reading the timeline get a strict
// ordering even on hosts where Date.now() is coarse.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.order || typeof opts.order.get !== "function") {
    throw new TypeError("pick-lists.create: opts.order with get(id) is required");
  }
  if (!opts.orderTracking || typeof opts.orderTracking.createShipment !== "function") {
    throw new TypeError("pick-lists.create: opts.orderTracking with createShipment() is required");
  }
  var orderPrim     = opts.order;
  var orderTracking = opts.orderTracking;
  var locations     = opts.inventoryLocations || null;
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Resolve the aisle_position for a (sku, location_code) tuple. When
  // the inventoryLocations dep is wired AND exposes a binForSku verb,
  // delegate to it (operators can ship their own bin map). Otherwise
  // fall back to the sku itself — deterministic, sortable, and
  // honest: the worksheet groups identical SKUs together even when
  // the warehouse has no explicit bin mapping.
  async function _aislePositionFor(sku, locationCode) {
    if (locations && typeof locations.binForSku === "function") {
      var bin = await locations.binForSku(sku, locationCode);
      if (typeof bin === "string" && bin.length) return bin;
    }
    return sku;
  }

  // Hydrate a list row + its lines into a single object. Lines come
  // back in `sequence_number ASC` order — the column was populated at
  // generateList time per the operator's chosen sort_by, so the
  // picker UI walks the route in the same order regardless of how
  // confirmLine updates interleave on the line rows.
  async function _getHydrated(id) {
    var rRow = await query("SELECT * FROM pick_lists WHERE id = ?1", [id]);
    if (!rRow.rows.length) return null;
    var list = rRow.rows[0];
    var rLines = await query(
      "SELECT * FROM pick_list_lines WHERE list_id = ?1 " +
      "ORDER BY sequence_number ASC, id ASC",
      [id],
    );
    list.lines = rLines.rows;
    return list;
  }

  // Sort the (about-to-be-inserted) line objects by the operator's
  // chosen sort_by. The DB index on (aisle_position) means the read
  // path can re-sort; sorting at insert lets the operator see the
  // intended order via raw row inspection too.
  function _applySort(lines, sortBy, orderIds) {
    if (sortBy === "aisle") {
      lines.sort(function (a, b) {
        if (a.aisle_position < b.aisle_position) return -1;
        if (a.aisle_position > b.aisle_position) return  1;
        if (a.sku < b.sku) return -1;
        if (a.sku > b.sku) return  1;
        return 0;
      });
    } else if (sortBy === "sku") {
      lines.sort(function (a, b) {
        if (a.sku < b.sku) return -1;
        if (a.sku > b.sku) return  1;
        if (a.order_id < b.order_id) return -1;
        if (a.order_id > b.order_id) return  1;
        return 0;
      });
    } else if (sortBy === "priority") {
      // Operator-supplied order_ids carry the priority order. Build
      // an index map so the sort is O(n log n) instead of O(n²).
      var prio = Object.create(null);
      for (var i = 0; i < orderIds.length; i += 1) prio[orderIds[i]] = i;
      lines.sort(function (a, b) {
        var pa = prio[a.order_id]; var pb = prio[b.order_id];
        if (pa !== pb) return pa - pb;
        if (a.sku < b.sku) return -1;
        if (a.sku > b.sku) return  1;
        return 0;
      });
    } else {
      // order_id — lexicographic on the order_id column, then sku.
      lines.sort(function (a, b) {
        if (a.order_id < b.order_id) return -1;
        if (a.order_id > b.order_id) return  1;
        if (a.sku < b.sku) return -1;
        if (a.sku > b.sku) return  1;
        return 0;
      });
    }
  }

  return {
    LIST_STATUSES:         LIST_STATUSES,
    SORT_BY_ENUM:          SORT_BY_ENUM,
    ELIGIBLE_ORDER_STATES: ELIGIBLE_ORDER_STATES,

    // Generate a worksheet from N open orders for the given
    // warehouse. Validates input, resolves order_ids (operator-
    // supplied or selected from the eligible-state queue), composes
    // `order.get(id)` to read each parent order's lines, populates
    // `aisle_position` via inventoryLocations.binForSku when wired,
    // sorts per `sort_by`, and persists header + lines + 'generated'
    // status. Returns the hydrated list.
    generateList: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pick-lists.generateList: input object required");
      }
      _code(input.location_code, "location_code");
      var sortBy = input.sort_by == null ? "aisle" : input.sort_by;
      _sortBy(sortBy);
      var maxLines = input.max_lines == null ? DEFAULT_MAX_LINES : input.max_lines;
      _maxLines(maxLines);

      // Resolve order_ids. Operator-supplied: validate each id +
      // refuse duplicates. Omitted: query the eligible-state queue
      // ordered by created_at ASC (oldest-first — those orders have
      // been waiting longest for fulfillment).
      var orderIds;
      if (input.order_ids != null) {
        if (!Array.isArray(input.order_ids) || input.order_ids.length === 0) {
          throw new TypeError("pick-lists.generateList: order_ids must be a non-empty array when supplied");
        }
        if (input.order_ids.length > MAX_ORDER_IDS) {
          throw new TypeError("pick-lists.generateList: order_ids must contain ≤ " + MAX_ORDER_IDS + " entries");
        }
        var seen = Object.create(null);
        orderIds = [];
        for (var i = 0; i < input.order_ids.length; i += 1) {
          var oid = _id(input.order_ids[i], "order_ids[" + i + "]");
          if (seen[oid]) {
            throw new TypeError("pick-lists.generateList: duplicate order_id " + JSON.stringify(oid));
          }
          seen[oid] = true;
          orderIds.push(oid);
        }
      } else {
        // Auto-select from eligible orders. The IN-clause is built
        // from a fixed enum (ELIGIBLE_ORDER_STATES) so no operator
        // input reaches the SQL string. The LIMIT bound is the
        // worksheet's max_lines cap interpreted as "at most this many
        // orders" — a conservative over-estimate (each order has ≥ 1
        // line) that the per-line cap further constrains below.
        var rOrders = await query(
          "SELECT id FROM orders WHERE status IN ('paid', 'fulfilling') " +
          "ORDER BY created_at ASC, id ASC LIMIT ?1",
          [maxLines],
        );
        orderIds = rOrders.rows.map(function (r) { return r.id; });
        if (orderIds.length === 0) {
          throw new TypeError("pick-lists.generateList: no eligible orders found " +
            "(none in status paid|fulfilling)");
        }
      }

      // Fan-out: pull each order's lines via the composed order.get
      // verb. Refuses unknown ids + ids whose status isn't eligible
      // — both surface as a clear TypeError instead of silently
      // producing a worksheet that omits the missing rows.
      var staged = [];
      for (var k = 0; k < orderIds.length; k += 1) {
        var ord = await orderPrim.get(orderIds[k]);
        if (!ord) {
          throw new TypeError("pick-lists.generateList: order " + orderIds[k] + " not found");
        }
        if (ELIGIBLE_ORDER_STATES.indexOf(ord.status) === -1) {
          throw new TypeError("pick-lists.generateList: order " + orderIds[k] +
            " is in status " + ord.status + " (must be one of " +
            ELIGIBLE_ORDER_STATES.join(", ") + ")");
        }
        for (var m = 0; m < ord.lines.length; m += 1) {
          if (staged.length >= maxLines) break;
          var ol = ord.lines[m];
          var aisle = await _aislePositionFor(ol.sku, input.location_code);
          staged.push({
            order_id:          ord.id,
            sku:               ol.sku,
            variant_id:        ol.variant_id == null ? null : ol.variant_id,
            expected_quantity: ol.qty,
            aisle_position:    aisle,
          });
        }
        if (staged.length >= maxLines) break;
      }

      if (staged.length === 0) {
        throw new TypeError("pick-lists.generateList: selected orders produced zero lines");
      }

      _applySort(staged, sortBy, orderIds);

      var listId = b.uuid.v7();
      var ts     = _now();
      try {
        await query(
          "INSERT INTO pick_lists (id, location_code, status, sort_by, generated_at) " +
          "VALUES (?1, ?2, 'generated', ?3, ?4)",
          [listId, input.location_code, sortBy, ts],
        );
        for (var n = 0; n < staged.length; n += 1) {
          var ln = staged[n];
          await query(
            "INSERT INTO pick_list_lines (id, list_id, order_id, sku, variant_id, " +
            "expected_quantity, aisle_position, sequence_number) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            [b.uuid.v7(), listId, ln.order_id, ln.sku, ln.variant_id,
             ln.expected_quantity, ln.aisle_position, n],
          );
        }
      } catch (e) {
        // Compensating cleanup so a partial write doesn't leave a
        // header with no lines on disk. The FK CASCADE on
        // pick_list_lines.list_id means the DELETE on the header
        // also removes any successfully-inserted lines.
        try { await query("DELETE FROM pick_lists WHERE id = ?1", [listId]); }
        catch (_e) { /* drop-silent — the original error is what the operator needs */ }
        throw e;
      }

      return await _getHydrated(listId);
    },

    // Read a hydrated list (header + lines) or null on miss. Validates
    // the id shape so a typo surfaces as a clear refusal instead of a
    // bare null that the caller has to disambiguate from "no such list".
    getList: async function (listId) {
      var id = _id(listId, "list_id");
      return await _getHydrated(id);
    },

    // List headers filtered by location_code and/or status. Returns
    // newest-first (generated_at DESC, id DESC) so the operator UI
    // surfaces fresh worksheets at the top. Lines are NOT hydrated —
    // the listing surface is for picking which list to drill into;
    // the operator calls getList for the lines.
    listLists: async function (listOpts) {
      listOpts = listOpts || {};
      var hasLoc    = listOpts.location_code !== undefined && listOpts.location_code !== null;
      var hasStatus = listOpts.status        !== undefined && listOpts.status        !== null;
      if (hasLoc)    _code(listOpts.location_code, "location_code");
      if (hasStatus) _status(listOpts.status);
      var sql, params;
      if (hasLoc && hasStatus) {
        sql = "SELECT * FROM pick_lists WHERE location_code = ?1 AND status = ?2 " +
              "ORDER BY generated_at DESC, id DESC";
        params = [listOpts.location_code, listOpts.status];
      } else if (hasLoc) {
        sql = "SELECT * FROM pick_lists WHERE location_code = ?1 " +
              "ORDER BY generated_at DESC, id DESC";
        params = [listOpts.location_code];
      } else if (hasStatus) {
        sql = "SELECT * FROM pick_lists WHERE status = ?1 " +
              "ORDER BY generated_at DESC, id DESC";
        params = [listOpts.status];
      } else {
        sql = "SELECT * FROM pick_lists ORDER BY generated_at DESC, id DESC";
        params = [];
      }
      return (await query(sql, params)).rows;
    },

    // Confirm one line. Stamps actual_quantity (defaults to expected
    // when the picker pulled it clean), picker_id, picked_at.
    // Transitions the list generated -> in_progress on the first
    // confirm. Refuses confirms once the list is terminal (complete /
    // cancelled).
    confirmLine: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pick-lists.confirmLine: input object required");
      }
      var listId = _id(input.list_id, "list_id");
      var lineId = _id(input.line_id, "line_id");
      _picker(input.picker_id);
      var list = await _getHydrated(listId);
      if (!list) {
        throw new TypeError("pick-lists.confirmLine: list " + listId + " not found");
      }
      if (list.status !== "generated" && list.status !== "in_progress") {
        throw new TypeError("pick-lists.confirmLine: list is " + list.status +
          ", only generated or in_progress lists accept confirms");
      }
      var match = null;
      for (var i = 0; i < list.lines.length; i += 1) {
        if (list.lines[i].id === lineId) { match = list.lines[i]; break; }
      }
      if (!match) {
        throw new TypeError("pick-lists.confirmLine: line " + lineId +
          " not on list " + listId);
      }
      var actual;
      if (input.actual_quantity == null) {
        actual = match.expected_quantity;
      } else {
        _nonNegInt(input.actual_quantity, "actual_quantity");
        actual = input.actual_quantity;
      }
      var ts = _now();
      await query(
        "UPDATE pick_list_lines SET actual_quantity = ?1, picked_by = ?2, picked_at = ?3 " +
        "WHERE id = ?4",
        [actual, input.picker_id, ts, lineId],
      );
      if (list.status === "generated") {
        await query("UPDATE pick_lists SET status = 'in_progress' WHERE id = ?1", [listId]);
      }
      return await _getHydrated(listId);
    },

    // in_progress -> complete. Refuses if any line is still
    // unconfirmed (actual_quantity IS NULL) — short-picks are settled
    // by confirming with actual_quantity=0, not by leaving the column
    // null. For every parent order represented on the list, calls
    // orderTracking.createShipment exactly once and captures the
    // returned shipment ids on the result so the operator UI can
    // deep-link each one.
    markListComplete: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pick-lists.markListComplete: input object required");
      }
      var listId = _id(input.list_id, "list_id");
      var list = await _getHydrated(listId);
      if (!list) {
        throw new TypeError("pick-lists.markListComplete: list " + listId + " not found");
      }
      if (list.status !== "generated" && list.status !== "in_progress") {
        throw new TypeError("pick-lists.markListComplete: list is " + list.status +
          ", only generated or in_progress lists can be completed");
      }
      // Every line must be settled. NULL actual_quantity is the
      // operator forgot — surface loudly.
      for (var i = 0; i < list.lines.length; i += 1) {
        if (list.lines[i].actual_quantity == null) {
          throw new TypeError("pick-lists.markListComplete: line " + list.lines[i].id +
            " (sku " + list.lines[i].sku + ") has not been confirmed");
        }
      }
      // Group lines by parent order_id so each parent gets exactly
      // one shipment. The insertion order is the line-walk order so
      // the shipments table reflects the priority the operator chose
      // when they sorted the list.
      var perOrder = Object.create(null);
      var orderSeq = [];
      for (var k = 0; k < list.lines.length; k += 1) {
        var oid = list.lines[k].order_id;
        if (!Object.prototype.hasOwnProperty.call(perOrder, oid)) {
          perOrder[oid] = [];
          orderSeq.push(oid);
        }
        perOrder[oid].push(list.lines[k]);
      }

      // Atomically claim completion BEFORE fanning out any shipment.
      // The JS status check above is necessary (it produces the
      // operator-facing "list is <status>" refusal) but NOT sufficient:
      // two concurrent markListComplete callers both read 'in_progress'
      // and would each run the createShipment loop, double-creating one
      // shipment per parent order. The conditional UPDATE — guarded by
      // the same precondition in its own WHERE — is the atomic claim
      // (SQLite/D1 serializes writers, so exactly one UPDATE matches a
      // row in an eligible state). The loser sees rowCount===0 and
      // refuses; only the winner proceeds to createShipment.
      var ts = _now();
      var claim = await query(
        "UPDATE pick_lists SET status = 'complete', completed_at = ?1 " +
        "WHERE id = ?2 AND status IN ('generated', 'in_progress')",
        [ts, listId],
      );
      if (!b.sql.casWon(claim).won) {
        // Lost the race (or the row left an eligible state between the
        // read and the claim). Surface the same terminal-state refusal
        // a sequential caller would see — the shipments belong to the
        // caller that won the claim.
        throw new TypeError("pick-lists.markListComplete: list is no longer " +
          "generated or in_progress (already completed or cancelled by a concurrent caller)");
      }

      var shipments = [];
      try {
        for (var m = 0; m < orderSeq.length; m += 1) {
          var ord = orderSeq[m];
          // A picked-from-shelf parcel has no carrier yet — the operator
          // assigns one when they hand it off. orderTracking's carrier enum
          // doesn't carry a "pickup" / "none" value, so the parcel rides the
          // 'other' escape hatch with a "pickup" label until a real carrier
          // is recorded against it (the operator updates the shipment, or a
          // shipping-label record supplies the carrier).
          var s = await orderTracking.createShipment({
            order_id:           ord,
            carrier:            "other",
            carrier_other_name: "pickup",
            notes:              "pick-list:" + listId,
          });
          shipments.push({
            order_id:    ord,
            shipment_id: s.id,
          });
        }
      } catch (e) {
        // The side-effect threw after the claim landed. Revert the claim
        // (self-targeting WHERE so we only undo a row WE moved to
        // 'complete') so the list isn't stranded terminal with a
        // partial / zero shipment fan-out — the operator can retry once
        // the createShipment fault clears.
        try {
          await query(
            "UPDATE pick_lists SET status = ?1, completed_at = NULL " +
            "WHERE id = ?2 AND status = 'complete'",
            [list.status, listId],
          );
        } catch (_e) { /* drop-silent — the original createShipment error is what the operator needs */ }
        throw e;
      }

      var hydrated = await _getHydrated(listId);
      hydrated.shipments = shipments;
      return hydrated;
    },

    // generated|in_progress -> cancelled. Persists the reason +
    // cancelled_at. Lines stay on disk so the partial-pick audit
    // trail survives. Refuses cancelling a complete list — the
    // shipments are out the door.
    cancelList: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("pick-lists.cancelList: input object required");
      }
      var listId = _id(input.list_id, "list_id");
      var reason = _reason(input.reason);
      if (!reason.length) {
        throw new TypeError("pick-lists.cancelList: reason must be a non-empty string");
      }
      var list = await _getHydrated(listId);
      if (!list) {
        throw new TypeError("pick-lists.cancelList: list " + listId + " not found");
      }
      if (list.status !== "generated" && list.status !== "in_progress") {
        throw new TypeError("pick-lists.cancelList: list is " + list.status +
          ", only generated or in_progress lists can be cancelled");
      }
      var ts = _now();
      await query(
        "UPDATE pick_lists SET status = 'cancelled', cancelled_at = ?1, cancel_reason = ?2 " +
        "WHERE id = ?3",
        [ts, reason, listId],
      );
      return await _getHydrated(listId);
    },

    // Per-line view of (expected, actual, diff). Returns every line
    // on the list — zero-diff included — so the variance report
    // doesn't omit clean picks; the operator can still see which
    // SKUs walked through cleanly alongside the short / over picks.
    // Returns null when the list_id doesn't exist.
    discrepanciesFor: async function (listId) {
      var id = _id(listId, "list_id");
      var list = await _getHydrated(id);
      if (!list) return null;
      var out = [];
      for (var i = 0; i < list.lines.length; i += 1) {
        var line = list.lines[i];
        var actual = line.actual_quantity == null ? null : line.actual_quantity;
        var diff = actual == null ? null : line.expected_quantity - actual;
        out.push({
          line_id:           line.id,
          order_id:          line.order_id,
          sku:               line.sku,
          variant_id:        line.variant_id == null ? null : line.variant_id,
          expected_quantity: line.expected_quantity,
          actual_quantity:   actual,
          discrepancy:       diff,
          aisle_position:    line.aisle_position,
        });
      }
      return out;
    },
  };
}

module.exports = {
  create:                create,
  LIST_STATUSES:         LIST_STATUSES,
  SORT_BY_ENUM:          SORT_BY_ENUM,
  ELIGIBLE_ORDER_STATES: ELIGIBLE_ORDER_STATES,
};
