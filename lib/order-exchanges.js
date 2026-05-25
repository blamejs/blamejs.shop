"use strict";
/**
 * @module shop.orderExchanges
 * @title  Order exchanges — customer-requested item swap
 *
 * @intro
 *   A customer wants a different item instead of a refund. They
 *   ship the original merchandise back; the operator ships a
 *   replacement out. The two arms of the swap progress
 *   independently — the customer's return may reach the warehouse
 *   before OR after the replacement reaches the customer — so the
 *   FSM tolerates both orderings and closeExchange collapses them
 *   into the terminal `closed` state once both sides land.
 *
 *   Distinct from `returns`: a return ends in a refund (money flows
 *   one way). An exchange ends in two physical movements (customer
 *   ships X back, operator ships Y out) and no monetary refund.
 *   Operators choosing between the two surfaces decide at request
 *   time which lifecycle to run; this primitive does NOT collapse
 *   to a returns row internally.
 *
 *   FSM:
 *
 *     pending   --approveExchange-->  approved --markReplacementShipped-->  shipped
 *         \                                  \                                  |
 *          --rejectExchange--> rejected       --rejectExchange--> rejected      |
 *                                                                               v
 *                                                  +---markReplacementDelivered--+
 *                                                  |                             |
 *                                                  v                             v
 *                                            delivered                       received
 *                                                  \                         (markReturnReceived
 *                                                   \                         from shipped)
 *                                                    +--closeExchange (both sides done) --> closed
 *
 *   Composition:
 *     - `returns`               — optional. When wired, the
 *       primitive's `request` step is offered as a peer surface for
 *       operators who prefer to author a returns RMA alongside the
 *       exchange (the link lives on the request layer; this
 *       primitive doesn't auto-create the RMA).
 *     - `order`                 — optional. When wired,
 *       `closeExchange` may surface the parent order's lines for
 *       audit-context (the primitive does NOT mutate the order FSM
 *       — an exchange's resolution does not by itself transition
 *       the order; the operator decides whether to drive the order
 *       state via `order.transition`).
 *     - `inventoryAllocations` — optional. When wired,
 *       `approveExchange` opens a hold on `replacement_sku` (+
 *       `replacement_variant_id`) so the replacement is pinned to
 *       the warehouse shelf before shipping. A hold failure rolls
 *       back the approval. Absent the handle, the operator owns
 *       inventory reservation out-of-band.
 *     - `query`                 — optional D1-shaped query handle;
 *       falls back to `b.externalDb.query` when omitted.
 *
 * @primitive orderExchanges
 * @related   b.uuid, b.guardUuid, returns, order, inventoryAllocations
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var REASONS = Object.freeze([
  "defective",
  "wrong-item",
  "wrong-size",
  "wrong-colour",
  "damaged-in-transit",
  "not-as-described",
  "other",
]);

var STATUSES = Object.freeze([
  "pending", "approved", "shipped", "delivered", "received", "closed", "rejected",
]);

var TERMINAL_STATES = Object.freeze(["closed", "rejected"]);

// FSM transition graph. Each (currentStatus, event) pair maps to a
// next state, or is absent when the transition is illegal. The
// closed terminal is reached via `closeExchange` from EITHER
// `delivered` or `received` — `closeExchange` then verifies both
// sides actually completed (delivered_at AND returned_at both
// non-null) before flipping the row.
var TRANSITIONS = {
  pending:   { approveExchange: "approved", rejectExchange: "rejected" },
  approved:  { markReplacementShipped: "shipped", rejectExchange: "rejected" },
  shipped:   { markReplacementDelivered: "delivered", markReturnReceived: "received" },
  delivered: { markReturnReceived: "received", closeExchange: "closed" },
  received:  { markReplacementDelivered: "delivered", closeExchange: "closed" },
  closed:    {},
  rejected:  {},
};

var SKU_RE              = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var MAX_REJECT_REASON   = 1024;
var MAX_TRACKING_LEN    = 128;
var MAX_CARRIER_LEN     = 64;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("order-exchanges: " + label + " — " + (e && e.message || "invalid UUID")); }
}
function _maybeUuid(s, label) {
  if (s == null) return null;
  return _uuid(s, label);
}
function _sku(s, label) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("order-exchanges: " + label +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}
function _reason(r) {
  if (typeof r !== "string" || REASONS.indexOf(r) === -1) {
    throw new TypeError("order-exchanges: reason must be one of " + REASONS.join(", "));
  }
  return r;
}
function _status(s) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError("order-exchanges: status must be one of " + STATUSES.join(", "));
  }
  return s;
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("order-exchanges: " + label + " must be a positive integer");
  }
  return n;
}
function _ts(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("order-exchanges: " + label + " must be a positive integer (epoch ms)");
  }
  return n;
}
function _boundedString(s, label, maxLen) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("order-exchanges: " + label + " must be a non-empty string");
  }
  if (s.length > maxLen) {
    throw new TypeError("order-exchanges: " + label + " must be <= " + maxLen + " characters");
  }
  // Refuse control bytes — same posture as other free-form text
  // columns in this framework.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("order-exchanges: " + label + " contains control bytes");
  }
  return s;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // returns is optional. When wired, callers can author a sibling
  // RMA at request time via the returned handle; this primitive
  // does NOT auto-create the RMA — operators decide whether the
  // exchange supersedes a returns lifecycle entirely or runs
  // alongside one. Shape check ensures `.request` exists when the
  // handle IS provided.
  var returnsPrim = opts.returns || null;
  if (returnsPrim && typeof returnsPrim.request !== "function") {
    throw new TypeError("order-exchanges.create: opts.returns must expose a request(input) method");
  }

  // order is optional. When wired, it's available for audit-context
  // reads only — this primitive does NOT mutate the order FSM. The
  // operator drives the order's own status (e.g. `partially_returned`)
  // through `order.transition` if their lifecycle calls for it.
  var orderPrim = opts.order || null;
  if (orderPrim && typeof orderPrim.get !== "function") {
    throw new TypeError("order-exchanges.create: opts.order must expose a get(id) method");
  }

  // inventoryAllocations is optional. When wired,
  // approveExchange opens a hold on the replacement SKU so the
  // replacement is pinned to a warehouse shelf at approval time.
  // The handle's holdForCart is reused (the hold is keyed by the
  // exchange id, surfaced through the `cart_id` slot — operators
  // who run a strict cart-id-must-be-a-cart shape filter the hold
  // out via the metadata). A hold failure rolls back the approval.
  var invAllocs = opts.inventoryAllocations || null;
  if (invAllocs && typeof invAllocs.holdForCart !== "function") {
    throw new TypeError("order-exchanges.create: opts.inventoryAllocations must expose a holdForCart(input) method");
  }

  // ---- monotonic clock --------------------------------------------------
  //
  // Operator-driven FSM transitions can land in the same wall-clock
  // millisecond on fast machines (a request immediately followed by
  // an approve in a test, for instance). Bumping by 1ms on a tie keeps
  // the timeline strictly increasing so a sort-by-timestamp read returns
  // the events in the order they were issued.
  var _lastTs = 0;
  function _monotonicTs() {
    var wall = Date.now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  async function _getRow(id) {
    var r = await query("SELECT * FROM order_exchanges WHERE id = ?1", [id]);
    return r.rows.length ? r.rows[0] : null;
  }

  function _assertTransition(currentStatus, event) {
    var allowed = TRANSITIONS[currentStatus];
    if (!allowed || !allowed[event]) {
      var err = new Error(
        "order-exchanges: transition '" + event + "' refused from state '" + currentStatus + "'"
      );
      err.code = "EXCHANGE_TRANSITION_REFUSED";
      throw err;
    }
    return allowed[event];
  }

  return {
    REASONS:         REASONS,
    STATUSES:        STATUSES,
    TERMINAL_STATES: TERMINAL_STATES,

    // Open a new exchange. Lands in `pending` awaiting operator
    // review. Refuses when reason / SKUs / quantities are malformed
    // and when the order_id / line_id are not strict UUIDs.
    requestExchange: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("order-exchanges.requestExchange: input object required");
      }
      var orderId            = _uuid(input.order_id, "order_id");
      var lineId             = _uuid(input.line_id,  "line_id");
      _sku(input.return_sku,      "return_sku");
      _sku(input.replacement_sku, "replacement_sku");
      _positiveInt(input.return_qty,      "return_qty");
      _positiveInt(input.replacement_qty, "replacement_qty");
      _reason(input.reason);
      var replacementVariantId = _maybeUuid(input.replacement_variant_id, "replacement_variant_id");

      var id = b.uuid.v7();
      var ts = _monotonicTs();
      await query(
        "INSERT INTO order_exchanges " +
        "(id, order_id, line_id, return_sku, return_qty, " +
        "replacement_sku, replacement_variant_id, replacement_qty, " +
        "reason, status, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?10)",
        [
          id, orderId, lineId, input.return_sku, input.return_qty,
          input.replacement_sku, replacementVariantId, input.replacement_qty,
          input.reason, ts,
        ],
      );
      return await _getRow(id);
    },

    // pending -> approved. Records the operator id. When
    // inventoryAllocations is wired, opens a hold on the replacement
    // SKU so the replacement is pinned to a warehouse shelf; a hold
    // failure surfaces to the caller and the approval is NOT
    // recorded (the DB row stays pending so a retry decides next).
    approveExchange: async function (exchangeId, input) {
      _uuid(exchangeId, "exchange id");
      if (!input || typeof input !== "object") {
        throw new TypeError("order-exchanges.approveExchange: input object required");
      }
      var approverId = _uuid(input.approver_id, "approver_id");

      var existing = await _getRow(exchangeId);
      if (!existing) {
        var miss = new TypeError("order-exchanges.approveExchange: exchange " + exchangeId + " not found");
        miss.code = "EXCHANGE_NOT_FOUND";
        throw miss;
      }
      _assertTransition(existing.status, "approveExchange");

      // Pin the replacement shelf BEFORE flipping the DB row. A
      // hold failure (insufficient stock, unknown location)
      // surfaces to the caller; the row stays pending so the next
      // operator attempt decides whether to retry, source from a
      // different shelf, or reject the exchange.
      if (invAllocs) {
        await invAllocs.holdForCart({
          cart_id:    existing.id,
          sku:        existing.replacement_sku,
          variant_id: existing.replacement_variant_id || null,
          quantity:   existing.replacement_qty,
          // allow:raw-time-literal — hold TTL in SECONDS (passed to holdForCart's ttl_seconds); C.TIME returns ms
          ttl_seconds: input.hold_ttl_seconds || 86400,
        });
      }

      var ts = _monotonicTs();
      await query(
        "UPDATE order_exchanges SET status = 'approved', approver_id = ?1, updated_at = ?2 " +
        "WHERE id = ?3",
        [approverId, ts, exchangeId],
      );
      return await _getRow(exchangeId);
    },

    // pending|approved -> rejected. Terminal. Records the operator
    // id + the reason surfaced to the customer.
    rejectExchange: async function (exchangeId, input) {
      _uuid(exchangeId, "exchange id");
      if (!input || typeof input !== "object") {
        throw new TypeError("order-exchanges.rejectExchange: input object required");
      }
      var approverId   = _uuid(input.approver_id, "approver_id");
      var rejectReason = _boundedString(input.reject_reason, "reject_reason", MAX_REJECT_REASON);

      var existing = await _getRow(exchangeId);
      if (!existing) {
        var miss = new TypeError("order-exchanges.rejectExchange: exchange " + exchangeId + " not found");
        miss.code = "EXCHANGE_NOT_FOUND";
        throw miss;
      }
      _assertTransition(existing.status, "rejectExchange");

      var ts = _monotonicTs();
      await query(
        "UPDATE order_exchanges SET status = 'rejected', approver_id = ?1, reject_reason = ?2, " +
        "updated_at = ?3 WHERE id = ?4",
        [approverId, rejectReason, ts, exchangeId],
      );
      return await _getRow(exchangeId);
    },

    // approved -> shipped. Captures tracking_number + carrier so
    // the storefront's order-detail page can render a tracking
    // link without joining a separate shipments table.
    markReplacementShipped: async function (exchangeId, input) {
      _uuid(exchangeId, "exchange id");
      if (!input || typeof input !== "object") {
        throw new TypeError("order-exchanges.markReplacementShipped: input object required");
      }
      var tracking = _boundedString(input.tracking_number, "tracking_number", MAX_TRACKING_LEN);
      var carrier  = _boundedString(input.carrier,         "carrier",         MAX_CARRIER_LEN);
      var shippedAt = input.shipped_at == null ? null : _ts(input.shipped_at, "shipped_at");

      var existing = await _getRow(exchangeId);
      if (!existing) {
        var miss = new TypeError("order-exchanges.markReplacementShipped: exchange " + exchangeId + " not found");
        miss.code = "EXCHANGE_NOT_FOUND";
        throw miss;
      }
      _assertTransition(existing.status, "markReplacementShipped");

      var ts = _monotonicTs();
      var stampedShippedAt = shippedAt == null ? ts : shippedAt;
      await query(
        "UPDATE order_exchanges SET status = 'shipped', tracking_number = ?1, carrier = ?2, " +
        "shipped_at = ?3, updated_at = ?4 WHERE id = ?5",
        [tracking, carrier, stampedShippedAt, ts, exchangeId],
      );
      return await _getRow(exchangeId);
    },

    // shipped|received -> delivered. Records when the replacement
    // reached the customer. From `received` (the customer's return
    // already landed), the next legal step is `closeExchange`.
    markReplacementDelivered: async function (exchangeId, input) {
      _uuid(exchangeId, "exchange id");
      input = input || {};
      var deliveredAt = input.delivered_at == null ? null : _ts(input.delivered_at, "delivered_at");

      var existing = await _getRow(exchangeId);
      if (!existing) {
        var miss = new TypeError("order-exchanges.markReplacementDelivered: exchange " + exchangeId + " not found");
        miss.code = "EXCHANGE_NOT_FOUND";
        throw miss;
      }
      var nextStatus = _assertTransition(existing.status, "markReplacementDelivered");

      var ts = _monotonicTs();
      var stamped = deliveredAt == null ? ts : deliveredAt;
      await query(
        "UPDATE order_exchanges SET status = ?1, delivered_at = ?2, updated_at = ?3 " +
        "WHERE id = ?4",
        [nextStatus, stamped, ts, exchangeId],
      );
      return await _getRow(exchangeId);
    },

    // shipped|delivered -> received. Records when the customer's
    // return reached the warehouse. From `delivered` (the
    // replacement is already with the customer), the next legal
    // step is `closeExchange`.
    markReturnReceived: async function (exchangeId, input) {
      _uuid(exchangeId, "exchange id");
      input = input || {};
      var returnedAt = input.returned_at == null ? null : _ts(input.returned_at, "returned_at");

      var existing = await _getRow(exchangeId);
      if (!existing) {
        var miss = new TypeError("order-exchanges.markReturnReceived: exchange " + exchangeId + " not found");
        miss.code = "EXCHANGE_NOT_FOUND";
        throw miss;
      }
      var nextStatus = _assertTransition(existing.status, "markReturnReceived");

      var ts = _monotonicTs();
      var stamped = returnedAt == null ? ts : returnedAt;
      await query(
        "UPDATE order_exchanges SET status = ?1, returned_at = ?2, updated_at = ?3 " +
        "WHERE id = ?4",
        [nextStatus, stamped, ts, exchangeId],
      );
      return await _getRow(exchangeId);
    },

    // delivered|received -> closed. The terminal collapse. Refuses
    // until BOTH delivered_at AND returned_at are non-null — the
    // FSM allows the transition from either parent state, but the
    // physical reality of "the exchange is complete" requires both
    // movements to have actually happened. Operators who need to
    // close out a half-complete exchange (e.g. customer kept the
    // replacement AND the original) drive `rejectExchange` from
    // pre-approval or `markReturnReceived` + `markReplacementDelivered`
    // by manually back-filling the timestamps.
    closeExchange: async function (exchangeId, input) {
      _uuid(exchangeId, "exchange id");
      input = input || {};
      var closedAt = input.closed_at == null ? null : _ts(input.closed_at, "closed_at");

      var existing = await _getRow(exchangeId);
      if (!existing) {
        var miss = new TypeError("order-exchanges.closeExchange: exchange " + exchangeId + " not found");
        miss.code = "EXCHANGE_NOT_FOUND";
        throw miss;
      }
      _assertTransition(existing.status, "closeExchange");
      if (existing.delivered_at == null || existing.returned_at == null) {
        var incomplete = new Error(
          "order-exchanges.closeExchange: cannot close — replacement delivered_at and customer returned_at must both be set " +
          "(delivered_at=" + existing.delivered_at + ", returned_at=" + existing.returned_at + ")"
        );
        incomplete.code = "EXCHANGE_BOTH_SIDES_REQUIRED";
        throw incomplete;
      }

      var ts = _monotonicTs();
      var stamped = closedAt == null ? ts : closedAt;
      await query(
        "UPDATE order_exchanges SET status = 'closed', closed_at = ?1, updated_at = ?2 " +
        "WHERE id = ?3",
        [stamped, ts, exchangeId],
      );
      return await _getRow(exchangeId);
    },

    // Single-row read. Returns null on miss so the caller can map
    // cleanly to HTTP 404.
    getExchange: async function (exchangeId) {
      _uuid(exchangeId, "exchange id");
      return await _getRow(exchangeId);
    },

    // Every exchange against a given order. Ordered created_at DESC
    // so the operator sees the newest claim first.
    exchangesForOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      var r = await query(
        "SELECT * FROM order_exchanges WHERE order_id = ?1 " +
        "ORDER BY created_at DESC, id DESC",
        [orderId],
      );
      return r.rows;
    },

    // Every exchange opened against any order belonging to a
    // customer. Reads through the injected `order` primitive's
    // `listForCustomer` to resolve the customer→order linkage;
    // refuses when `order` is not wired (this primitive does NOT
    // duplicate the customer→order index).
    exchangesForCustomer: async function (customerId, listOpts) {
      _uuid(customerId, "customer_id");
      if (!orderPrim || typeof orderPrim.listForCustomer !== "function") {
        throw new TypeError("order-exchanges.exchangesForCustomer: opts.order must be wired (and expose listForCustomer) for this read");
      }
      listOpts = listOpts || {};
      var page = await orderPrim.listForCustomer(customerId, { limit: 100 });
      var orders = (page && page.rows) || [];
      if (!orders.length) return [];
      var placeholders = [];
      var params = [];
      for (var i = 0; i < orders.length; i += 1) {
        placeholders.push("?" + (i + 1));
        params.push(orders[i].id);
      }
      var sql = "SELECT * FROM order_exchanges WHERE order_id IN (" +
                placeholders.join(", ") + ") ORDER BY created_at DESC, id DESC";
      return (await query(sql, params)).rows;
    },

    // Operator queue: every exchange not yet in a terminal state.
    // Ordered by created_at ASC so the oldest claim surfaces first
    // (FIFO — the customer who's been waiting longest gets the
    // operator's next attention).
    openExchanges: async function (listOpts) {
      listOpts = listOpts || {};
      var statusFilter = null;
      if (listOpts.status != null) {
        statusFilter = _status(listOpts.status);
        if (TERMINAL_STATES.indexOf(statusFilter) !== -1) {
          throw new TypeError("order-exchanges.openExchanges: status filter must be a non-terminal status, got " +
            JSON.stringify(statusFilter));
        }
      }
      var sql, params;
      if (statusFilter) {
        sql = "SELECT * FROM order_exchanges WHERE status = ?1 " +
              "ORDER BY created_at ASC, id ASC";
        params = [statusFilter];
      } else {
        sql = "SELECT * FROM order_exchanges WHERE status NOT IN ('closed', 'rejected') " +
              "ORDER BY created_at ASC, id ASC";
        params = [];
      }
      return (await query(sql, params)).rows;
    },

    // Operator dashboard summary. Counts every exchange opened in
    // the window broken out by status; surfaces approval-throughput
    // (median ms from pending -> approved) and rejection-rate so
    // the operator can spot a swing in customer-experience health.
    // `from` is inclusive, `to` exclusive — same shape as other
    // window readers in the framework.
    metricsForPeriod: async function (input) {
      input = input || {};
      _ts(input.from, "from");
      _ts(input.to,   "to");
      if (input.to <= input.from) {
        throw new TypeError("order-exchanges.metricsForPeriod: to must be > from");
      }

      // Counts by status across the window.
      var statusRows = (await query(
        "SELECT status, COUNT(*) AS n FROM order_exchanges " +
        "WHERE created_at >= ?1 AND created_at < ?2 GROUP BY status",
        [input.from, input.to],
      )).rows;
      var countsByStatus = {};
      for (var s = 0; s < STATUSES.length; s += 1) countsByStatus[STATUSES[s]] = 0;
      var total = 0;
      for (var r = 0; r < statusRows.length; r += 1) {
        countsByStatus[statusRows[r].status] = Number(statusRows[r].n);
        total += Number(statusRows[r].n);
      }

      // Closed-rate + rejection-rate over the window. Total may be 0
      // on a brand-new shop; surface as 0 (not NaN) so dashboards
      // don't render garbage.
      var closedCount   = countsByStatus.closed   || 0;
      var rejectedCount = countsByStatus.rejected || 0;
      var closedRate    = total > 0 ? closedCount   / total : 0;
      var rejectedRate  = total > 0 ? rejectedCount / total : 0;

      // Counts by reason for the same window.
      var reasonRows = (await query(
        "SELECT reason, COUNT(*) AS n FROM order_exchanges " +
        "WHERE created_at >= ?1 AND created_at < ?2 GROUP BY reason",
        [input.from, input.to],
      )).rows;
      var countsByReason = {};
      for (var i = 0; i < REASONS.length; i += 1) countsByReason[REASONS[i]] = 0;
      for (var j = 0; j < reasonRows.length; j += 1) {
        countsByReason[reasonRows[j].reason] = Number(reasonRows[j].n);
      }

      return {
        total_count:        total,
        counts_by_status:   countsByStatus,
        counts_by_reason:   countsByReason,
        closed_rate:        closedRate,
        rejected_rate:      rejectedRate,
      };
    },
  };
}

module.exports = {
  create:          create,
  REASONS:         REASONS,
  STATUSES:        STATUSES,
  TERMINAL_STATES: TERMINAL_STATES,
};
