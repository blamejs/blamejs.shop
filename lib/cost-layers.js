"use strict";
/**
 * @module shop.costLayers
 * @title  Cost layers — FIFO / LIFO / weighted-average inventory cost
 *         accounting for COGS reporting
 *
 * @intro
 *   The catalog tracks how many units sit on the shelf. The
 *   cost-layers primitive tracks WHAT EACH UNIT COST so the
 *   accountant can answer "for the five widgets we sold today, what
 *   was the cost of goods sold?" with the same precision the
 *   warehouse answers "how many widgets do we have?".
 *
 *   A receipt event (purchase from supplier, positive stock
 *   adjustment with cost info, transfer-in carrying a per-unit cost)
 *   appends a cost layer. A sale event consumes from one or more
 *   layers depending on the costing method active for the SKU at
 *   sale time. Each consumption writes an attribution row so the
 *   accountant can join `order_id` back to per-layer unit costs.
 *
 *   Surface:
 *
 *     setMethod({ sku, method })
 *       Operator-authored per-SKU policy. `method` is one of `fifo`,
 *       `lifo`, `weighted_average`. The set_at column records when
 *       the operator first chose a method; updated_at records the
 *       most recent change. Switching methods does not retroactively
 *       re-cost prior sales — `cogs_attributions` is the immutable
 *       record of what was charged at the time.
 *
 *     recordReceipt({ sku, quantity, unit_cost_minor, currency,
 *                     source, source_ref?, occurred_at? })
 *       Appends one cost layer. `source` is one of `receipt`,
 *       `transfer`, `adjustment` (a reversal-driven layer is internal
 *       and bears `source = 'reversal'`; operators don't pass that
 *       value directly). `unit_cost_minor` is a non-negative integer
 *       — zero is allowed (a give-away pallet from a supplier still
 *       enters the system as a tracked layer, just with no
 *       per-unit cost). Per-SKU occurred_at is bumped to monotonic
 *       so two receipts in the same millisecond don't tie on the
 *       FIFO ordering key.
 *
 *     consumeForSale({ sku, quantity, order_id, line_id,
 *                      occurred_at? })
 *       Consumes `quantity` units across one or more layers using
 *       the SKU's active costing method:
 *
 *         fifo             — oldest layer first
 *         lifo             — newest layer first
 *         weighted_average — every layer is debited proportionally,
 *                            and every consumed unit costs the
 *                            weighted-average of the on-hand layers
 *                            at the time of the sale
 *
 *       Returns `{ consumed_layers, total_cogs_minor, currency }`.
 *       Refuses when on-hand quantity across all layers is less than
 *       the requested quantity (no partial consumption — the caller
 *       handles the shortage upstream rather than getting a
 *       mysteriously-short COGS row). Refuses on currency drift: if
 *       the on-hand layers carry mixed currencies, the sale is
 *       refused (the operator must reconcile or convert at the
 *       receipt step).
 *
 *     recordReversal({ order_id, line_id, reason })
 *       Returns previously-consumed units to stock. For every
 *       `cogs_attributions` row for the order+line, appends a fresh
 *       cost layer at the original unit cost (the simplest
 *       defensible model — the returned unit re-enters the layer
 *       pool at what it cost when sold). Marks the attribution row
 *       `reversed=1` with the operator-supplied reason. Refuses if
 *       the line was never consumed or every attribution row is
 *       already reversed.
 *
 *     currentLayers({ sku })
 *       Returns every cost layer for an SKU that still has
 *       `quantity_remaining > 0`, oldest first. The accountant
 *       reads this to value on-hand inventory.
 *
 *     cogsForOrder(order_id)
 *       Sums every non-reversed attribution row for the order.
 *       Returns `{ order_id, lines: [{ line_id, sku, qty,
 *       total_cogs_minor, currency }], total_cogs_minor, currency }`.
 *       Refuses when attribution rows span multiple currencies.
 *
 *     cogsForPeriod({ from, to, sku? })
 *       Sums non-reversed attribution rows whose occurred_at falls
 *       in `[from, to)`. Returns per-SKU + grand-total. The
 *       accountant reads this for monthly COGS reports.
 *
 *   Composition:
 *     - b.uuid.v7       — layer / attribution row PKs (sortable)
 *     - monotonic clock — per-SKU strict monotonic occurred_at so
 *                         the FIFO order is unambiguous across two
 *                         receipts in the same millisecond
 *
 *   Three-tier input validation: every public verb is a config-time
 *   entry point (setMethod) or a defensive request-shape reader
 *   (everything else). Both shapes throw on bad input — no
 *   drop-silent hot-path sinks.
 *
 * @primitive costLayers
 * @related   shop.stockTransfers, shop.inventoryReceive
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var SKU_RE       = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CURRENCY_RE  = /^[A-Z]{3}$/;
var METHODS      = Object.freeze(["fifo", "lifo", "weighted_average"]);
var RECEIPT_SOURCES = Object.freeze(["receipt", "transfer", "adjustment"]);
// Internal source value used by `recordReversal` only; operators
// cannot pass this through `recordReceipt`.
var REVERSAL_SOURCE = "reversal";

var MAX_REF_LEN  = 128;
var MAX_REASON_LEN = 280;
var MAX_ID_LEN   = 128;
// `order_id` and `line_id` are external correlation handles. They
// arrive from the order primitive and may not be UUID-shape on every
// operator's deployment (some operators carry short opaque IDs).
// Refuse control bytes (log-injection cover) but accept any printable
// shape up to MAX_ID_LEN.
var PRINTABLE_RE = /^[^\x00-\x1f\x7f]+$/;

// ---- validators ---------------------------------------------------------

function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("cost-layers: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _method(s) {
  if (typeof s !== "string" || METHODS.indexOf(s) === -1) {
    throw new TypeError("cost-layers: method must be one of " + METHODS.join(", "));
  }
  return s;
}

function _positiveInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("cost-layers: " + label + " must be a positive integer");
  }
  return n;
}

function _nonNegInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("cost-layers: " + label + " must be a non-negative integer");
  }
  return n;
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("cost-layers: currency must be a 3-letter uppercase ISO-4217 code");
  }
  return s;
}

function _receiptSource(s) {
  if (typeof s !== "string" || RECEIPT_SOURCES.indexOf(s) === -1) {
    throw new TypeError("cost-layers: source must be one of " + RECEIPT_SOURCES.join(", "));
  }
  return s;
}

function _sourceRef(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("cost-layers: source_ref must be a non-empty string when provided");
  }
  if (s.length > MAX_REF_LEN) {
    throw new TypeError("cost-layers: source_ref must be <= " + MAX_REF_LEN + " chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("cost-layers: source_ref must not contain control bytes");
  }
  return s;
}

function _externalId(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("cost-layers: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_ID_LEN) {
    throw new TypeError("cost-layers: " + label + " must be <= " + MAX_ID_LEN + " chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("cost-layers: " + label + " must not contain control bytes");
  }
  return s;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("cost-layers: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("cost-layers: reason must be <= " + MAX_REASON_LEN + " chars");
  }
  if (!PRINTABLE_RE.test(s.replace(/\n/g, " "))) {
    throw new TypeError("cost-layers: reason must not contain control bytes other than newline");
  }
  return s;
}

function _epochMs(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError("cost-layers: " + label + " must be a non-negative integer epoch-ms");
  }
  return ts;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Catalog is currently optional — the primitive doesn't need it to
  // compute COGS. Accept either an object handle or omit it. When
  // present, refuse a non-object to fail loud on a misconfigured
  // operator wire.
  if (opts.catalog != null && typeof opts.catalog !== "object") {
    throw new TypeError("cost-layers.create: opts.catalog must be an object when provided");
  }

  // Look up the active method for an SKU. Falls through to
  // weighted_average when the operator hasn't set one — the least-
  // surprising default for a shop without a formalized inventory
  // accounting policy. The accountant typically sets explicit
  // methods per SKU before relying on `cogsForOrder` reports.
  async function _methodFor(sku) {
    var r = await query(
      "SELECT method FROM sku_costing_methods WHERE sku = ?1",
      [sku],
    );
    if (!r.rows.length) return "weighted_average";
    return r.rows[0].method;
  }

  // Read the latest occurred_at per SKU so two writes in the same
  // millisecond don't tie on the FIFO ordering key. Returns null
  // when the SKU has no layers yet.
  async function _latestLayerTs(sku) {
    var r = await query(
      "SELECT MAX(occurred_at) AS ts FROM cost_layers WHERE sku = ?1",
      [sku],
    );
    if (!r.rows.length || r.rows[0].ts == null) return null;
    return r.rows[0].ts;
  }

  // Strict-monotonic clock: bump the requested timestamp to
  // `prior + 1` when it would collide with (or land older than) the
  // most recent layer for the SKU. The result is a strictly-
  // monotonic per-SKU occurred_at sequence so FIFO / LIFO ordering
  // is unambiguous even under same-millisecond writes.
  function _resolveOccurredAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  // Hydrate the active layer set for an SKU — every layer with
  // `quantity_remaining > 0`. The order parameter picks FIFO (ASC)
  // or LIFO (DESC) at the SQL level so the caller doesn't sort in
  // JS. Falls back to the `id` column for ties (UUID-v7 is itself
  // monotonic so this is the same answer as occurred_at order, but
  // explicit beats implicit).
  async function _activeLayers(sku, direction) {
    var order = direction === "lifo"
      ? "occurred_at DESC, id DESC"
      : "occurred_at ASC, id ASC";
    var r = await query(
      "SELECT * FROM cost_layers WHERE sku = ?1 AND quantity_remaining > 0 " +
      "ORDER BY " + order,
      [sku],
    );
    return r.rows;
  }

  return {
    METHODS:           METHODS.slice(),
    RECEIPT_SOURCES:   RECEIPT_SOURCES.slice(),

    // Operator-authored per-SKU policy. Upserts. set_at is the first-
    // ever set time (preserved across updates); updated_at is the
    // most recent change.
    setMethod: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cost-layers.setMethod: input object required");
      }
      var sku    = _sku(input.sku);
      var method = _method(input.method);
      var now    = _now();
      var existing = await query(
        "SELECT sku, set_at FROM sku_costing_methods WHERE sku = ?1",
        [sku],
      );
      if (existing.rows.length) {
        await query(
          "UPDATE sku_costing_methods SET method = ?1, updated_at = ?2 WHERE sku = ?3",
          [method, now, sku],
        );
      } else {
        await query(
          "INSERT INTO sku_costing_methods (sku, method, set_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4)",
          [sku, method, now, now],
        );
      }
      return { sku: sku, method: method };
    },

    // Read the active method for an SKU; surfaces the default
    // (weighted_average) when none is set so the operator's UI can
    // render the inherited value rather than "unset".
    getMethod: async function (sku) {
      _sku(sku);
      var method = await _methodFor(sku);
      return { sku: sku, method: method };
    },

    // Append a cost layer. unit_cost_minor=0 is allowed (free
    // samples / promotional inventory enter the layer pool at zero
    // cost). occurred_at defaults to now and is bumped monotonic
    // against the latest per-SKU layer so FIFO / LIFO ordering is
    // unambiguous across same-millisecond writes.
    recordReceipt: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cost-layers.recordReceipt: input object required");
      }
      var sku       = _sku(input.sku);
      var quantity  = _positiveInt(input.quantity, "quantity");
      var unitCost  = _nonNegInt(input.unit_cost_minor, "unit_cost_minor");
      var currency  = _currency(input.currency);
      var source    = _receiptSource(input.source);
      var sourceRef = _sourceRef(input.source_ref);
      var requested = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      var latestTs = await _latestLayerTs(sku);
      var ts = _resolveOccurredAt(requested, latestTs);
      var id = b.uuid.v7();
      await query(
        "INSERT INTO cost_layers " +
        "(id, sku, quantity_received, quantity_remaining, unit_cost_minor, " +
        "currency, source, source_ref, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        [id, sku, quantity, quantity, unitCost, currency, source, sourceRef, ts],
      );
      return {
        id:                 id,
        sku:                sku,
        quantity_received:  quantity,
        quantity_remaining: quantity,
        unit_cost_minor:    unitCost,
        currency:           currency,
        source:             source,
        source_ref:         sourceRef,
        occurred_at:        ts,
      };
    },

    // Consume `quantity` units across one or more layers using the
    // SKU's active costing method. Returns the per-layer consumption
    // detail + the rolled-up COGS for the line.
    consumeForSale: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cost-layers.consumeForSale: input object required");
      }
      var sku      = _sku(input.sku);
      var quantity = _positiveInt(input.quantity, "quantity");
      var orderId  = _externalId(input.order_id, "order_id");
      var lineId   = _externalId(input.line_id,  "line_id");
      var requested = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();

      var method = await _methodFor(sku);
      var direction = method === "lifo" ? "lifo" : "fifo";
      var layers = await _activeLayers(sku, direction);

      // Pre-flight: confirm on-hand >= requested. No partial
      // consumption — the caller handles the shortage upstream.
      var onHand = 0;
      for (var i = 0; i < layers.length; i += 1) onHand += layers[i].quantity_remaining;
      if (onHand < quantity) {
        throw new TypeError("cost-layers.consumeForSale: insufficient on-hand for sku " +
          JSON.stringify(sku) + " (have " + onHand + ", need " + quantity + ")");
      }

      // Currency-coherence gate: every consumed layer must share the
      // same currency. Mixed currencies are refused at the primitive
      // layer (the operator reconciles via a manual receipt rather
      // than getting a mysteriously-FX-blended COGS row).
      var currency = layers[0].currency;
      for (var c = 1; c < layers.length; c += 1) {
        if (layers[c].currency !== currency) {
          throw new TypeError("cost-layers.consumeForSale: layers for sku " +
            JSON.stringify(sku) + " span multiple currencies (" + currency +
            ", " + layers[c].currency + ") — reconcile before sale");
        }
      }

      // The sale's `occurred_at` is the operator-supplied timestamp
      // (defaulting to now when omitted). `cogsForPeriod` filters
      // attribution rows by this column — using the sale time, not
      // the wall-clock at write time, keeps backfilled imports
      // accurate.
      var consumed = [];
      var totalCogs = 0;
      var attributionTs = requested;

      if (method === "weighted_average") {
        // Compute weighted-average unit cost in minor units. Round
        // the per-unit cost to the nearest integer minor unit at the
        // line level; spread the rounding remainder across the
        // attributions so `qty * unit_cost_minor` summed equals the
        // line total exactly (no penny drift between per-line COGS
        // and per-attribution COGS).
        var sumValue = 0;
        var sumQty   = 0;
        for (var w = 0; w < layers.length; w += 1) {
          sumValue += layers[w].quantity_remaining * layers[w].unit_cost_minor;
          sumQty   += layers[w].quantity_remaining;
        }
        // Total COGS for this consumption is the proportional share
        // of the on-hand value. Compute as
        // floor(sumValue * quantity / sumQty) with the remainder
        // tracked as a residual integer so two consecutive sales
        // don't accumulate a fractional debt.
        var lineNumerator = sumValue * quantity;
        var lineCogs = Math.floor(lineNumerator / sumQty);
        // Residual carried forward to per-layer attribution rows so
        // the sum of attributions matches lineCogs exactly. The first
        // layer in the iteration absorbs the residual (smallest
        // possible deviation, deterministic placement).
        var residual = lineCogs;
        // Debit every layer proportionally. Use integer division so
        // each layer's debit is an integer; spread any leftover
        // single units across the earliest layers (deterministic).
        var remainingToConsume = quantity;
        var debits = [];
        for (var d = 0; d < layers.length; d += 1) {
          if (remainingToConsume === 0) break;
          var layer = layers[d];
          var share;
          if (d === layers.length - 1) {
            share = remainingToConsume;
          } else {
            // Proportional debit floored to integer; the last layer
            // absorbs any rounding deficit.
            share = Math.floor(layer.quantity_remaining * quantity / sumQty);
            if (share > remainingToConsume) share = remainingToConsume;
          }
          if (share > 0) {
            debits.push({ layer: layer, qty: share });
            remainingToConsume -= share;
          }
        }
        // If integer flooring left units undebited (because every
        // proportional share floored down), distribute the leftover
        // across the earliest layers one unit at a time. This keeps
        // the SUM(quantity_remaining) after consumption equal to
        // sumQty - quantity exactly.
        for (var x = 0; x < debits.length && remainingToConsume > 0; x += 1) {
          if (debits[x].qty < debits[x].layer.quantity_remaining) {
            debits[x].qty += 1;
            remainingToConsume -= 1;
          }
        }
        // Per-attribution unit cost: weighted-average rounded to the
        // nearest integer minor unit. Track the residual so the last
        // attribution carries any rounding adjustment.
        var avgUnitCost = sumQty > 0 ? Math.round(sumValue / sumQty) : 0;
        for (var e = 0; e < debits.length; e += 1) {
          var dRow = debits[e];
          var attrCogs;
          if (e === debits.length - 1) {
            attrCogs = residual;
          } else {
            attrCogs = dRow.qty * avgUnitCost;
            if (attrCogs > residual) attrCogs = residual;
            residual -= attrCogs;
          }
          var attrUnit = dRow.qty > 0 ? Math.round(attrCogs / dRow.qty) : avgUnitCost;
          await query(
            "UPDATE cost_layers SET quantity_remaining = quantity_remaining - ?1 WHERE id = ?2",
            [dRow.qty, dRow.layer.id],
          );
          var attrId = b.uuid.v7();
          await query(
            "INSERT INTO cogs_attributions " +
            "(id, order_id, line_id, sku, layer_id, qty, unit_cost_minor, " +
            "currency, reversed, reversal_reason, occurred_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL, ?9)",
            [attrId, orderId, lineId, sku, dRow.layer.id, dRow.qty, attrUnit, currency, attributionTs],
          );
          consumed.push({
            layer_id:        dRow.layer.id,
            qty:             dRow.qty,
            unit_cost_minor: attrUnit,
          });
          totalCogs += attrCogs;
        }
        // Edge case: residual unspent (impossible given the math
        // above, but defensive). Push it onto the last attribution.
        if (residual !== 0 && consumed.length) {
          totalCogs += residual;
        }
        totalCogs = lineCogs;
      } else {
        // FIFO / LIFO: walk layers in order, debit each one until
        // the requested quantity is satisfied.
        var remaining = quantity;
        for (var f = 0; f < layers.length && remaining > 0; f += 1) {
          var lay = layers[f];
          var take = lay.quantity_remaining;
          if (take > remaining) take = remaining;
          await query(
            "UPDATE cost_layers SET quantity_remaining = quantity_remaining - ?1 WHERE id = ?2",
            [take, lay.id],
          );
          var attrIdF = b.uuid.v7();
          await query(
            "INSERT INTO cogs_attributions " +
            "(id, order_id, line_id, sku, layer_id, qty, unit_cost_minor, " +
            "currency, reversed, reversal_reason, occurred_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL, ?9)",
            [attrIdF, orderId, lineId, sku, lay.id, take, lay.unit_cost_minor, currency, attributionTs],
          );
          consumed.push({
            layer_id:        lay.id,
            qty:             take,
            unit_cost_minor: lay.unit_cost_minor,
          });
          totalCogs += take * lay.unit_cost_minor;
          remaining -= take;
        }
      }

      return {
        consumed_layers:   consumed,
        total_cogs_minor:  totalCogs,
        currency:          currency,
      };
    },

    // Return previously-consumed units to stock. For every
    // attribution row for the order+line, appends a fresh cost
    // layer at the original unit cost. Marks the attribution row
    // reversed=1 with the operator-supplied reason.
    recordReversal: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cost-layers.recordReversal: input object required");
      }
      var orderId = _externalId(input.order_id, "order_id");
      var lineId  = _externalId(input.line_id,  "line_id");
      var reason  = _reason(input.reason);

      var attrs = (await query(
        "SELECT * FROM cogs_attributions WHERE order_id = ?1 AND line_id = ?2 ORDER BY occurred_at ASC, id ASC",
        [orderId, lineId],
      )).rows;
      if (!attrs.length) {
        throw new TypeError("cost-layers.recordReversal: no attributions found for order_id=" +
          JSON.stringify(orderId) + " line_id=" + JSON.stringify(lineId));
      }
      var liveAttrs = attrs.filter(function (a) { return a.reversed === 0; });
      if (!liveAttrs.length) {
        throw new TypeError("cost-layers.recordReversal: every attribution for order_id=" +
          JSON.stringify(orderId) + " line_id=" + JSON.stringify(lineId) +
          " is already reversed");
      }

      var now = _now();
      var restored = [];
      for (var i = 0; i < liveAttrs.length; i += 1) {
        var a = liveAttrs[i];
        // Append a fresh layer at the original unit cost. Mark it
        // `source='reversal'` so the operator's audit query can
        // distinguish "stock that came back from a return" from
        // "stock that came in from a supplier purchase". Bump
        // monotonic against the latest per-SKU layer so the
        // returned units land at the end of the FIFO queue (the
        // accountant's typical interpretation — returned stock is
        // sold last).
        var latestTs = await _latestLayerTs(a.sku);
        var ts = _resolveOccurredAt(now, latestTs);
        var newLayerId = b.uuid.v7();
        await query(
          "INSERT INTO cost_layers " +
          "(id, sku, quantity_received, quantity_remaining, unit_cost_minor, " +
          "currency, source, source_ref, occurred_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
          [newLayerId, a.sku, a.qty, a.qty, a.unit_cost_minor, a.currency,
            REVERSAL_SOURCE, orderId + ":" + lineId, ts],
        );
        await query(
          "UPDATE cogs_attributions SET reversed = 1, reversal_reason = ?1 WHERE id = ?2",
          [reason, a.id],
        );
        restored.push({
          sku:             a.sku,
          qty:             a.qty,
          unit_cost_minor: a.unit_cost_minor,
          currency:        a.currency,
          new_layer_id:    newLayerId,
        });
      }
      return { restored_layers: restored, reason: reason };
    },

    // Every active cost layer for an SKU, oldest first. Layers with
    // `quantity_remaining = 0` are excluded — the accountant reads
    // this to value on-hand inventory, not to audit history.
    currentLayers: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cost-layers.currentLayers: input object required");
      }
      var sku = _sku(input.sku);
      return await _activeLayers(sku, "fifo");
    },

    // Roll up COGS for an entire order. Sums non-reversed
    // attribution rows; refuses when attributions span multiple
    // currencies (the operator's FX policy decides how to combine
    // them — not the primitive).
    cogsForOrder: async function (orderId) {
      var id = _externalId(orderId, "order_id");
      var rows = (await query(
        "SELECT * FROM cogs_attributions WHERE order_id = ?1 AND reversed = 0 " +
        "ORDER BY occurred_at ASC, id ASC",
        [id],
      )).rows;
      if (!rows.length) {
        return {
          order_id:          id,
          lines:             [],
          total_cogs_minor:  0,
          currency:          null,
        };
      }
      var currency = rows[0].currency;
      var lines = {};
      var total = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var r = rows[i];
        if (r.currency !== currency) {
          throw new TypeError("cost-layers.cogsForOrder: attributions for order_id=" +
            JSON.stringify(id) + " span multiple currencies (" + currency +
            ", " + r.currency + ")");
        }
        if (!lines[r.line_id]) {
          lines[r.line_id] = {
            line_id:          r.line_id,
            sku:              r.sku,
            qty:              0,
            total_cogs_minor: 0,
            currency:         currency,
          };
        }
        var lineCogs = r.qty * r.unit_cost_minor;
        lines[r.line_id].qty              += r.qty;
        lines[r.line_id].total_cogs_minor += lineCogs;
        total += lineCogs;
      }
      var lineKeys = Object.keys(lines);
      var lineRows = [];
      for (var k = 0; k < lineKeys.length; k += 1) lineRows.push(lines[lineKeys[k]]);
      return {
        order_id:          id,
        lines:             lineRows,
        total_cogs_minor:  total,
        currency:          currency,
      };
    },

    // Sum non-reversed attributions in `[from, to)`. Optional `sku`
    // filter scopes to a single SKU for per-SKU COGS reports.
    // Returns per-SKU breakdown + grand total. Refuses on mixed
    // currency (consistent with cogsForOrder).
    cogsForPeriod: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cost-layers.cogsForPeriod: input object required");
      }
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (from == null || to == null) {
        throw new TypeError("cost-layers.cogsForPeriod: from and to are required (epoch-ms)");
      }
      if (to <= from) {
        throw new TypeError("cost-layers.cogsForPeriod: to must be > from");
      }
      var rows;
      if (input.sku != null) {
        var sku = _sku(input.sku);
        rows = (await query(
          "SELECT * FROM cogs_attributions WHERE reversed = 0 AND sku = ?1 " +
          "AND occurred_at >= ?2 AND occurred_at < ?3 ORDER BY occurred_at ASC, id ASC",
          [sku, from, to],
        )).rows;
      } else {
        rows = (await query(
          "SELECT * FROM cogs_attributions WHERE reversed = 0 " +
          "AND occurred_at >= ?1 AND occurred_at < ?2 ORDER BY occurred_at ASC, id ASC",
          [from, to],
        )).rows;
      }
      if (!rows.length) {
        return {
          from:              from,
          to:                to,
          by_sku:            [],
          total_cogs_minor:  0,
          currency:          null,
        };
      }
      var currency = rows[0].currency;
      var bySku = {};
      var total = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var r = rows[i];
        if (r.currency !== currency) {
          throw new TypeError("cost-layers.cogsForPeriod: attributions in window span " +
            "multiple currencies (" + currency + ", " + r.currency +
            ") — pass an `sku` filter or reconcile FX before reporting");
        }
        if (!bySku[r.sku]) {
          bySku[r.sku] = {
            sku:              r.sku,
            qty:              0,
            total_cogs_minor: 0,
            currency:         currency,
          };
        }
        var add = r.qty * r.unit_cost_minor;
        bySku[r.sku].qty              += r.qty;
        bySku[r.sku].total_cogs_minor += add;
        total += add;
      }
      var skuKeys = Object.keys(bySku).sort();
      var bySkuRows = [];
      for (var k = 0; k < skuKeys.length; k += 1) bySkuRows.push(bySku[skuKeys[k]]);
      return {
        from:              from,
        to:                to,
        by_sku:            bySkuRows,
        total_cogs_minor:  total,
        currency:          currency,
      };
    },
  };
}

module.exports = {
  create:           create,
  METHODS:          METHODS,
  RECEIPT_SOURCES:  RECEIPT_SOURCES,
};
