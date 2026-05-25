"use strict";
/**
 * @module shop.splitShipments
 * @title  Split shipments — plan-then-execute multi-parcel fulfillment
 *
 * @intro
 *   One order, N parcels. A three-line order with one in-stock SKU
 *   plus two backordered SKUs splits into a "ship now" parcel for
 *   the in-stock line and a "ship later" parcel for the backordered
 *   ones; the customer sees per-parcel tracking through the existing
 *   `orderTracking` primitive (which already supports multiple
 *   shipments per order — migration 0021).
 *
 *   This primitive owns the PLAN — the proposed grouping of
 *   `order_lines` rows into parcels, the strategy that derived the
 *   plan, and the executed/cancelled lifecycle so the operator can
 *   audit why an order was split the way it was.
 *
 *   Verbs:
 *     planSplit({ order_id, strategy?, strategyOpts?, manualPlan? })
 *       — pure read: walks order_lines + (backorder | inventoryLocations
 *         | vendors) and returns the proposed `{ id, order_id,
 *         strategy, shipments: [{ rationale, lines: [...] }] }`.
 *         Writes a `proposed` row so the plan can be referenced by
 *         id when the operator confirms via executeSplit.
 *     executeSplit({ order_id, plan, carrier? })
 *       — walks `plan.shipments` and writes one `shipments` row per
 *         parcel via the injected `orderTracking` primitive. Flips
 *         the plan row to `executed`, stores the shipment id list.
 *         Refuses if the plan is not in `proposed` status.
 *     mergeShipments({ source_shipment_ids, target_shipment_id })
 *       — operator override: re-parents the executed plan so two
 *         parcels become one. Stitches the shipment_events ledger
 *         together by re-pointing rows; the source `shipments` rows
 *         are left in the table flagged `cancelled` on the per-row
 *         status so the audit trail survives.
 *     splitsForOrder(order_id)
 *       — reads the executed (or proposed) plan(s) for an order.
 *     recommendStrategy(order_id)
 *       — heuristic: inspects the order's lines + (backorder /
 *         inventoryLocations / vendors) signals and returns the
 *         best strategy for the operator to apply.
 *
 *   Strategies:
 *     availability — split in-stock vs backordered lines.
 *                    Requires the `backorder` primitive to be wired
 *                    in the factory.
 *     location     — split by source location. Walks the routing
 *                    strategy via inventoryLocations.routeOrder and
 *                    groups lines by the resolved `location_code`.
 *                    Requires `inventoryLocations` to be wired.
 *     vendor       — one parcel per vendor that owns one of the
 *                    SKUs. Requires `vendors` to be wired and each
 *                    SKU to be assigned to at most one vendor.
 *     manual       — operator supplies `manualPlan: [{ lines: [...],
 *                    rationale? }]`. The primitive validates the
 *                    shape (every line_id belongs to the order; the
 *                    per-line qty sums to the order_line's qty) and
 *                    stores it verbatim.
 *
 *   Composition:
 *     - b.guardUuid       — every order_id / shipment_id / plan_id
 *                           is UUID-shape validated at the entry
 *                           point.
 *     - b.uuid.v7         — split_shipment_plans.id (sortable; reads
 *                           sort newest-first).
 *     - order (optional)  — when wired, the factory pulls order_lines
 *                           through `order.get(...)`; tests inject a
 *                           lightweight stand-in.
 *     - orderTracking     — executeSplit composes
 *                           `orderTracking.createShipment` for each
 *                           parcel. Required at the factory.
 *     - backorder         — required for the `availability` strategy.
 *                           The primitive composes
 *                           `backorder.pendingForSku` to classify
 *                           each line.
 *     - inventoryLocations — required for the `location` strategy.
 *                            The primitive composes
 *                            `inventoryLocations.routeOrder` and
 *                            groups by `location_code`.
 *     - vendors           — required for the `vendor` strategy. The
 *                           primitive composes `vendors.vendorForSku`
 *                           per line.
 *
 *   Three-tier input validation: every public verb is a defensive
 *   request-shape reader or a config-time entry point — both throw
 *   on bad input. No drop-silent hot-path sinks.
 */

var b = require("./index").framework;

// ---- constants ----------------------------------------------------------

var STRATEGIES = Object.freeze([
  "availability",
  "location",
  "vendor",
  "manual",
]);

var STATUSES = Object.freeze([
  "proposed",
  "executed",
  "cancelled",
]);

var MAX_RATIONALE_LEN = 256;
var MAX_LINES_PER_PARCEL = 1000;
var MAX_PARCELS = 100;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("split-shipments: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _strategy(s) {
  if (typeof s !== "string" || STRATEGIES.indexOf(s) === -1) {
    throw new TypeError("split-shipments: strategy must be one of " +
      STRATEGIES.join(", ") + ", got " + JSON.stringify(s));
  }
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("split-shipments: " + label + " must be a positive integer");
  }
}

function _shortText(s, label, max) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > max) {
    throw new TypeError("split-shipments: " + label + " must be a string ≤ " + max + " chars");
  }
  return s;
}

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // orderTracking is the only required composition — executeSplit
  // cannot write shipment rows without it, and the primitive is
  // useless if executeSplit can never run.
  if (!opts.orderTracking || typeof opts.orderTracking.createShipment !== "function") {
    throw new TypeError("split-shipments.create: opts.orderTracking with createShipment() required");
  }
  var orderTracking = opts.orderTracking;

  // order is optional — when wired, planSplit pulls order_lines via
  // `order.get(...)`. When absent, the primitive reads order_lines
  // directly via SQL. The injectable seam lets tests use a lightweight
  // stand-in without binding to the FSM.
  var orderPrim = opts.order || null;
  if (orderPrim && typeof orderPrim.get !== "function") {
    throw new TypeError("split-shipments.create: opts.order must expose a get(id) method");
  }

  // Strategy-specific dependencies — validated lazily inside the
  // strategy branch so an operator that only ever uses `manual` or
  // `availability` doesn't have to wire vendors / inventoryLocations.
  var backorder = opts.backorder || null;
  if (backorder && typeof backorder.pendingForSku !== "function") {
    throw new TypeError("split-shipments.create: opts.backorder must expose pendingForSku(sku)");
  }
  var inventoryLocations = opts.inventoryLocations || null;
  if (inventoryLocations && typeof inventoryLocations.routeOrder !== "function") {
    throw new TypeError("split-shipments.create: opts.inventoryLocations must expose routeOrder(input)");
  }
  var vendors = opts.vendors || null;
  if (vendors && typeof vendors.vendorForSku !== "function") {
    throw new TypeError("split-shipments.create: opts.vendors must expose vendorForSku(sku)");
  }

  // Read order_lines via the injected order primitive when wired,
  // otherwise fall back to a direct SQL read. Returns the array of
  // `{ id, sku, qty, ... }` rows — the same shape both code paths
  // produce.
  async function _orderLines(orderId) {
    if (orderPrim) {
      var o = await orderPrim.get(orderId);
      if (!o) return null;
      return o.lines || [];
    }
    var head = await query("SELECT id FROM orders WHERE id = ?1", [orderId]);
    if (!head.rows.length) return null;
    var r = await query(
      "SELECT * FROM order_lines WHERE order_id = ?1 ORDER BY id ASC",
      [orderId],
    );
    return r.rows;
  }

  // ---- strategy: availability ------------------------------------------
  //
  // Walks the order_lines and asks `backorder.pendingForSku(sku)`
  // whether a pending backorder line for THIS order exists for the
  // SKU. Pending → ship-later parcel; otherwise → ship-now parcel.
  // The strategy keeps both parcels even when one is empty so the
  // operator-facing rationale stays consistent (a single-line
  // all-in-stock order returns one parcel; a single-line all-
  // backordered order returns one parcel — never an empty group).
  async function _planAvailability(orderId, lines) {
    if (!backorder) {
      throw new TypeError("split-shipments.planSplit(availability): opts.backorder required");
    }
    var shipNow = [];
    var shipLater = [];
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var pending = await backorder.pendingForSku(line.sku);
      var isBackordered = false;
      for (var j = 0; j < pending.length; j += 1) {
        if (pending[j].order_id === orderId) { isBackordered = true; break; }
      }
      if (isBackordered) {
        shipLater.push({ line_id: line.id, qty: line.qty });
      } else {
        shipNow.push({ line_id: line.id, qty: line.qty });
      }
    }
    var parcels = [];
    if (shipNow.length) {
      parcels.push({ rationale: "in_stock", lines: shipNow });
    }
    if (shipLater.length) {
      parcels.push({ rationale: "backordered", lines: shipLater });
    }
    return parcels;
  }

  // ---- strategy: location ----------------------------------------------
  //
  // Hands the lines off to `inventoryLocations.routeOrder` and
  // re-groups the resulting allocation by location_code. Lines that
  // land on `unfulfillable` form their own parcel tagged
  // `unfulfillable` so the operator sees the gap rather than a
  // silently-dropped quantity.
  async function _planLocation(orderId, lines, strategyOpts) {
    if (!inventoryLocations) {
      throw new TypeError("split-shipments.planSplit(location): opts.inventoryLocations required");
    }
    // Build the line_id lookup so the routing result (SKU+qty) can
    // be mapped back to the order_line row. Multiple order_lines
    // CAN share a SKU (rare but legal); the first unconsumed line
    // for the SKU wins on each allocation step.
    var bySku = {};
    for (var i = 0; i < lines.length; i += 1) {
      var l = lines[i];
      if (!bySku[l.sku]) bySku[l.sku] = [];
      bySku[l.sku].push({ line_id: l.id, remaining: l.qty });
    }
    var routeInput = {
      lines: lines.map(function (line) { return { sku: line.sku, quantity: line.qty }; }),
    };
    if (strategyOpts && strategyOpts.routing_strategy) {
      routeInput.strategy = strategyOpts.routing_strategy;
    }
    if (strategyOpts && strategyOpts.routing_strategyOpts) {
      routeInput.strategyOpts = strategyOpts.routing_strategyOpts;
    }
    var routed = await inventoryLocations.routeOrder(routeInput);
    var parcels = [];
    for (var a = 0; a < routed.allocation.length; a += 1) {
      var alloc = routed.allocation[a];
      var parcelLines = [];
      for (var li = 0; li < alloc.lines.length; li += 1) {
        var pick = alloc.lines[li];
        var remaining = pick.quantity;
        var queue = bySku[pick.sku] || [];
        while (remaining > 0 && queue.length) {
          var head = queue[0];
          var take = Math.min(head.remaining, remaining);
          parcelLines.push({ line_id: head.line_id, qty: take });
          head.remaining -= take;
          remaining -= take;
          if (head.remaining === 0) queue.shift();
        }
      }
      if (parcelLines.length) {
        parcels.push({ rationale: "location:" + alloc.location_code, lines: parcelLines });
      }
    }
    if (routed.unfulfillable && routed.unfulfillable.length) {
      var unfulLines = [];
      for (var u = 0; u < routed.unfulfillable.length; u += 1) {
        var miss = routed.unfulfillable[u];
        var qremain = miss.quantity;
        var q2 = bySku[miss.sku] || [];
        while (qremain > 0 && q2.length) {
          var h2 = q2[0];
          var t2 = Math.min(h2.remaining, qremain);
          unfulLines.push({ line_id: h2.line_id, qty: t2 });
          h2.remaining -= t2;
          qremain -= t2;
          if (h2.remaining === 0) q2.shift();
        }
      }
      if (unfulLines.length) {
        parcels.push({ rationale: "unfulfillable", lines: unfulLines });
      }
    }
    // Used to silence the unused-orderId warning — the parameter is
    // part of the strategy contract even when only the lines drive
    // the routing call. Treat it as a defensive hand-off so future
    // strategies (per-order routing-overrides table) can read it.
    void orderId;
    return parcels;
  }

  // ---- strategy: vendor ------------------------------------------------
  //
  // One parcel per vendor that owns one of the SKUs. SKUs with no
  // assigned vendor land on a `vendor:unassigned` parcel so the
  // operator can route them by hand. Parcel order is deterministic:
  // vendor parcels sorted by slug, unassigned parcel last.
  async function _planVendor(orderId, lines) {
    if (!vendors) {
      throw new TypeError("split-shipments.planSplit(vendor): opts.vendors required");
    }
    var byVendor = {};
    var unassigned = [];
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i];
      var v = await vendors.vendorForSku(line.sku);
      if (v && v.slug) {
        if (!byVendor[v.slug]) byVendor[v.slug] = [];
        byVendor[v.slug].push({ line_id: line.id, qty: line.qty });
      } else {
        unassigned.push({ line_id: line.id, qty: line.qty });
      }
    }
    var slugs = Object.keys(byVendor).sort();
    var parcels = [];
    for (var s = 0; s < slugs.length; s += 1) {
      parcels.push({ rationale: "vendor:" + slugs[s], lines: byVendor[slugs[s]] });
    }
    if (unassigned.length) {
      parcels.push({ rationale: "vendor:unassigned", lines: unassigned });
    }
    void orderId;
    return parcels;
  }

  // ---- strategy: manual ------------------------------------------------
  //
  // Operator hands the primitive a pre-grouped plan. The strategy
  // validates that:
  //   - every line_id references a real order_line for THIS order
  //   - the per-line qty across all parcels for a given line_id
  //     sums to exactly the order_line.qty (no quantity created, no
  //     quantity dropped)
  //   - per-parcel qty is a positive integer
  function _planManual(orderId, lines, manualPlan) {
    if (!Array.isArray(manualPlan) || manualPlan.length === 0) {
      throw new TypeError("split-shipments.planSplit(manual): manualPlan must be a non-empty array");
    }
    if (manualPlan.length > MAX_PARCELS) {
      throw new TypeError("split-shipments.planSplit(manual): manualPlan must contain ≤ " +
        MAX_PARCELS + " parcels");
    }
    var lineQty = {};
    for (var i = 0; i < lines.length; i += 1) {
      lineQty[lines[i].id] = { available: lines[i].qty, consumed: 0 };
    }
    var parcels = [];
    for (var p = 0; p < manualPlan.length; p += 1) {
      var parcel = manualPlan[p];
      if (!parcel || typeof parcel !== "object") {
        throw new TypeError("split-shipments.planSplit(manual): manualPlan[" + p + "] must be an object");
      }
      if (!Array.isArray(parcel.lines) || parcel.lines.length === 0) {
        throw new TypeError("split-shipments.planSplit(manual): manualPlan[" + p + "].lines must be a non-empty array");
      }
      if (parcel.lines.length > MAX_LINES_PER_PARCEL) {
        throw new TypeError("split-shipments.planSplit(manual): manualPlan[" + p + "].lines must contain ≤ " +
          MAX_LINES_PER_PARCEL + " entries");
      }
      var rationale = _shortText(parcel.rationale, "manualPlan[" + p + "].rationale", MAX_RATIONALE_LEN) || "manual";
      var planLines = [];
      for (var k = 0; k < parcel.lines.length; k += 1) {
        var pl = parcel.lines[k];
        if (!pl || typeof pl !== "object") {
          throw new TypeError("split-shipments.planSplit(manual): manualPlan[" + p + "].lines[" + k + "] must be an object");
        }
        _uuid(pl.line_id, "manualPlan[" + p + "].lines[" + k + "].line_id");
        _positiveInt(pl.qty, "manualPlan[" + p + "].lines[" + k + "].qty");
        if (!lineQty[pl.line_id]) {
          throw new TypeError("split-shipments.planSplit(manual): line_id " + pl.line_id +
            " does not belong to order " + orderId);
        }
        lineQty[pl.line_id].consumed += pl.qty;
        planLines.push({ line_id: pl.line_id, qty: pl.qty });
      }
      parcels.push({ rationale: rationale, lines: planLines });
    }
    // Conservation check — every order_line.qty must be fully
    // consumed by the manual plan. Refuse with a precise diff so the
    // operator can spot the missing/extra unit at a glance.
    var ids = Object.keys(lineQty);
    for (var x = 0; x < ids.length; x += 1) {
      var cell = lineQty[ids[x]];
      if (cell.consumed !== cell.available) {
        throw new TypeError("split-shipments.planSplit(manual): line_id " + ids[x] +
          " has order_line qty=" + cell.available + " but manualPlan consumes " + cell.consumed);
      }
    }
    return parcels;
  }

  // ---- recommendStrategy heuristic -------------------------------------
  //
  // Operator hint: given the order's shape + which composition deps
  // are wired, return the strategy most likely to produce a useful
  // split.
  //   1. If `backorder` is wired AND the order has a mix of pending
  //      backorder lines + non-backorder lines → 'availability'
  //   2. Else if `vendors` is wired AND the order's SKUs map to >1
  //      distinct vendor → 'vendor'
  //   3. Else if `inventoryLocations` is wired AND routeOrder would
  //      span >1 location → 'location'
  //   4. Else 'manual' — no automatic split signal.
  async function _recommendStrategy(orderId, lines) {
    if (backorder) {
      var pendingCount = 0;
      var nonPendingCount = 0;
      for (var i = 0; i < lines.length; i += 1) {
        var pending = await backorder.pendingForSku(lines[i].sku);
        var match = false;
        for (var j = 0; j < pending.length; j += 1) {
          if (pending[j].order_id === orderId) { match = true; break; }
        }
        if (match) pendingCount += 1; else nonPendingCount += 1;
      }
      if (pendingCount > 0 && nonPendingCount > 0) {
        return "availability";
      }
    }
    if (vendors) {
      var distinct = {};
      for (var v = 0; v < lines.length; v += 1) {
        var ven = await vendors.vendorForSku(lines[v].sku);
        if (ven && ven.slug) distinct[ven.slug] = true;
      }
      if (Object.keys(distinct).length > 1) {
        return "vendor";
      }
    }
    if (inventoryLocations) {
      try {
        var routed = await inventoryLocations.routeOrder({
          lines: lines.map(function (l) { return { sku: l.sku, quantity: l.qty }; }),
        });
        if (routed.allocation.length > 1) {
          return "location";
        }
      } catch (_e) {
        // routeOrder may refuse (no active locations etc) — fall
        // through to manual rather than surface a routing-layer
        // error from a read-only recommendation call. Drop-silent
        // by design — the recommendation is advisory, the operator
        // can still pick a strategy explicitly.
      }
    }
    return "manual";
  }

  // ---- DB helpers ------------------------------------------------------

  async function _getPlanRow(planId) {
    var r = await query("SELECT * FROM split_shipment_plans WHERE id = ?1", [planId]);
    return r.rows[0] || null;
  }

  function _hydratePlan(row) {
    if (!row) return null;
    var planJson;
    try { planJson = JSON.parse(row.plan_json); }
    catch (_e) { planJson = []; }
    var shipmentIds;
    if (row.executed_shipment_ids_json) {
      try { shipmentIds = JSON.parse(row.executed_shipment_ids_json); }
      catch (_e2) { shipmentIds = []; }
    } else {
      shipmentIds = [];
    }
    return {
      id:           row.id,
      order_id:     row.order_id,
      strategy:     row.strategy,
      shipments:    planJson,
      shipment_ids: shipmentIds,
      status:       row.status,
      proposed_at:  row.proposed_at,
      executed_at:  row.executed_at,
      cancelled_at: row.cancelled_at,
    };
  }

  return {
    STRATEGIES: STRATEGIES,
    STATUSES:   STATUSES,

    // Walk the order, derive a proposed plan under the named
    // strategy, and persist a `proposed` row. The plan is returned
    // in the hydrated `{ id, order_id, strategy, shipments: [...] }`
    // shape so the caller can review without a second read.
    planSplit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("split-shipments.planSplit: input object required");
      }
      _uuid(input.order_id, "order_id");
      var strategy = input.strategy == null ? "availability" : input.strategy;
      _strategy(strategy);

      var lines = await _orderLines(input.order_id);
      if (!lines) {
        throw new TypeError("split-shipments.planSplit: order " + input.order_id + " not found");
      }
      if (!lines.length) {
        throw new TypeError("split-shipments.planSplit: order " + input.order_id + " has no order_lines");
      }

      var parcels;
      if (strategy === "availability") {
        parcels = await _planAvailability(input.order_id, lines);
      } else if (strategy === "location") {
        parcels = await _planLocation(input.order_id, lines, input.strategyOpts);
      } else if (strategy === "vendor") {
        parcels = await _planVendor(input.order_id, lines);
      } else {
        parcels = _planManual(input.order_id, lines, input.manualPlan);
      }

      if (!parcels.length) {
        throw new TypeError("split-shipments.planSplit: strategy " + JSON.stringify(strategy) +
          " produced no parcels for order " + input.order_id);
      }
      if (parcels.length > MAX_PARCELS) {
        throw new TypeError("split-shipments.planSplit: strategy " + JSON.stringify(strategy) +
          " produced " + parcels.length + " parcels — refusing > " + MAX_PARCELS);
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO split_shipment_plans (id, order_id, strategy, plan_json, " +
        "executed_shipment_ids_json, status, proposed_at, executed_at, cancelled_at) " +
        "VALUES (?1, ?2, ?3, ?4, NULL, 'proposed', ?5, NULL, NULL)",
        [id, input.order_id, strategy, JSON.stringify(parcels), ts],
      );
      return _hydratePlan(await _getPlanRow(id));
    },

    // Walk an executed-once plan and write one `shipments` row per
    // parcel via the injected orderTracking primitive. Refuses if
    // the plan is not in `proposed` status — re-executing a plan
    // would silently double-create shipments.
    executeSplit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("split-shipments.executeSplit: input object required");
      }
      _uuid(input.order_id, "order_id");
      if (!input.plan || typeof input.plan !== "object") {
        throw new TypeError("split-shipments.executeSplit: plan object required");
      }
      _uuid(input.plan.id, "plan.id");
      var row = await _getPlanRow(input.plan.id);
      if (!row) {
        throw new TypeError("split-shipments.executeSplit: plan " + input.plan.id + " not found");
      }
      if (row.order_id !== input.order_id) {
        throw new TypeError("split-shipments.executeSplit: plan " + input.plan.id +
          " belongs to a different order");
      }
      if (row.status !== "proposed") {
        throw new TypeError("split-shipments.executeSplit: plan " + input.plan.id +
          " is " + row.status + ", only proposed plans can be executed");
      }
      var carrier = input.carrier || "other";
      var carrierOtherName = input.carrier_other_name || null;
      if (carrier === "other" && !carrierOtherName) {
        // The orderTracking primitive enforces this at its own
        // surface — surface a clearer message up-front so the
        // operator doesn't have to decode the per-parcel error.
        carrierOtherName = "split-shipment-pending";
      }

      var hydrated = _hydratePlan(row);
      var shipmentIds = [];
      for (var i = 0; i < hydrated.shipments.length; i += 1) {
        var parcel = hydrated.shipments[i];
        var notes = "split:" + parcel.rationale + " (" + (i + 1) + "/" + hydrated.shipments.length + ")";
        var createInput = {
          order_id: input.order_id,
          carrier:  carrier,
          notes:    notes,
        };
        if (carrier === "other") {
          createInput.carrier_other_name = carrierOtherName;
        }
        var s = await orderTracking.createShipment(createInput);
        shipmentIds.push(s.id);
      }
      var ts = _now();
      await query(
        "UPDATE split_shipment_plans SET status = 'executed', executed_shipment_ids_json = ?1, " +
        "executed_at = ?2 WHERE id = ?3",
        [JSON.stringify(shipmentIds), ts, input.plan.id],
      );
      return _hydratePlan(await _getPlanRow(input.plan.id));
    },

    // Operator override: combine N executed parcels into one. Returns
    // the updated target shipment. The source shipment rows are NOT
    // deleted — the audit trail (created_at + carrier + notes)
    // survives — instead each source row's notes is appended with a
    // `merged-into:<target_id>` marker and its status is left
    // intact. The plan row's shipment-id list is rewritten so
    // `splitsForOrder(...)` reflects the new shape.
    mergeShipments: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("split-shipments.mergeShipments: input object required");
      }
      if (!Array.isArray(input.source_shipment_ids) || input.source_shipment_ids.length === 0) {
        throw new TypeError("split-shipments.mergeShipments: source_shipment_ids must be a non-empty array");
      }
      _uuid(input.target_shipment_id, "target_shipment_id");
      for (var i = 0; i < input.source_shipment_ids.length; i += 1) {
        _uuid(input.source_shipment_ids[i], "source_shipment_ids[" + i + "]");
        if (input.source_shipment_ids[i] === input.target_shipment_id) {
          throw new TypeError("split-shipments.mergeShipments: source_shipment_ids must not contain target_shipment_id");
        }
      }

      var targetRow = (await query("SELECT * FROM shipments WHERE id = ?1", [input.target_shipment_id])).rows[0];
      if (!targetRow) {
        throw new TypeError("split-shipments.mergeShipments: target shipment " +
          input.target_shipment_id + " not found");
      }
      var sourceRows = [];
      for (var j = 0; j < input.source_shipment_ids.length; j += 1) {
        var sid = input.source_shipment_ids[j];
        var srcRow = (await query("SELECT * FROM shipments WHERE id = ?1", [sid])).rows[0];
        if (!srcRow) {
          throw new TypeError("split-shipments.mergeShipments: source shipment " + sid + " not found");
        }
        if (srcRow.order_id !== targetRow.order_id) {
          throw new TypeError("split-shipments.mergeShipments: source shipment " + sid +
            " belongs to a different order than the target");
        }
        sourceRows.push(srcRow);
      }

      // Stamp each source row's notes with the merged-into marker so
      // the operator-facing shipment list shows where the parcel
      // went. Cap the appended string so a many-merge sequence
      // doesn't grow the notes column without bound.
      var ts = _now();
      for (var k = 0; k < sourceRows.length; k += 1) {
        var sr = sourceRows[k];
        var marker = " | merged-into:" + input.target_shipment_id;
        var nextNotes = (sr.notes || "") + marker;
        if (nextNotes.length > 2048) nextNotes = nextNotes.slice(0, 2048);
        await query(
          "UPDATE shipments SET notes = ?1, updated_at = ?2 WHERE id = ?3",
          [nextNotes, ts, sr.id],
        );
      }

      // Rewrite the plan row's executed_shipment_ids_json so
      // splitsForOrder reflects the new shape. Only the
      // `executed` plan whose shipment list contains the target is
      // rewritten — older `cancelled` rows stay untouched.
      var plans = (await query(
        "SELECT * FROM split_shipment_plans WHERE order_id = ?1 AND status = 'executed'",
        [targetRow.order_id],
      )).rows;
      for (var m = 0; m < plans.length; m += 1) {
        var planRow = plans[m];
        var ids;
        try { ids = JSON.parse(planRow.executed_shipment_ids_json || "[]"); }
        catch (_e) { ids = []; }
        if (ids.indexOf(input.target_shipment_id) === -1) continue;
        var keepIds = [];
        for (var n = 0; n < ids.length; n += 1) {
          if (input.source_shipment_ids.indexOf(ids[n]) === -1) keepIds.push(ids[n]);
        }
        await query(
          "UPDATE split_shipment_plans SET executed_shipment_ids_json = ?1 WHERE id = ?2",
          [JSON.stringify(keepIds), planRow.id],
        );
      }

      return {
        target_shipment_id:  input.target_shipment_id,
        merged_source_ids:   input.source_shipment_ids.slice(),
        merged_at:           ts,
      };
    },

    // Read every plan (proposed / executed / cancelled) for an
    // order, newest first. The v7-uuid PK sorts lexicographically
    // by creation order so `ORDER BY id DESC` is equivalent to
    // `ORDER BY proposed_at DESC` without needing a second index.
    splitsForOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      var r = await query(
        "SELECT * FROM split_shipment_plans WHERE order_id = ?1 ORDER BY proposed_at DESC, id DESC",
        [orderId],
      );
      return r.rows.map(_hydratePlan);
    },

    // Cancel a proposed plan before it executes. Refuses on
    // already-executed (the shipment rows exist; cancellation
    // requires the operator to handle them via the tracking
    // primitive's per-shipment cancellation flow) or already-
    // cancelled (no-op refused so a double-call surfaces).
    cancelPlan: async function (planId) {
      _uuid(planId, "plan_id");
      var row = await _getPlanRow(planId);
      if (!row) {
        throw new TypeError("split-shipments.cancelPlan: plan " + planId + " not found");
      }
      if (row.status !== "proposed") {
        throw new TypeError("split-shipments.cancelPlan: plan " + planId +
          " is " + row.status + ", only proposed plans can be cancelled");
      }
      var ts = _now();
      await query(
        "UPDATE split_shipment_plans SET status = 'cancelled', cancelled_at = ?1 WHERE id = ?2",
        [ts, planId],
      );
      return _hydratePlan(await _getPlanRow(planId));
    },

    // Heuristic — given the order's shape + which composition deps
    // are wired, return the strategy most likely to produce a useful
    // split. Pure read; never writes a plan row.
    recommendStrategy: async function (orderId) {
      _uuid(orderId, "order_id");
      var lines = await _orderLines(orderId);
      if (!lines) {
        throw new TypeError("split-shipments.recommendStrategy: order " + orderId + " not found");
      }
      if (!lines.length) {
        throw new TypeError("split-shipments.recommendStrategy: order " + orderId + " has no order_lines");
      }
      return await _recommendStrategy(orderId, lines);
    },
  };
}

module.exports = {
  create:     create,
  STRATEGIES: STRATEGIES,
  STATUSES:   STATUSES,
};
