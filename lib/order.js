"use strict";
/**
 * @module shop.order
 * @title  Order primitive — FSM-driven post-checkout record
 *
 * @intro
 *   Orders are the immutable post-checkout record of a sale. The
 *   row in `orders` is created in `pending` state by the checkout
 *   primitive at payment-intent creation time; state transitions
 *   thereafter go through the order FSM (composed on `b.fsm`), and
 *   each transition appends a row to `order_transitions` so the
 *   lifecycle is auditable end-to-end.
 *
 *   States:
 *     pending     — payment intent created, awaiting capture
 *     paid        — payment captured
 *     fulfilling  — warehouse picking
 *     shipped     — handed to carrier
 *     delivered   — confirmed received
 *     refunded    — refund issued (terminal)
 *     cancelled   — cancelled before fulfillment (terminal)
 *
 *   Events → transitions:
 *     mark_paid          : pending → paid
 *     start_fulfillment  : paid → fulfilling
 *     mark_shipped       : fulfilling → shipped
 *     mark_delivered     : shipped → delivered
 *     cancel             : pending → cancelled, paid → cancelled
 *     refund             : paid|fulfilling|shipped|delivered → refunded
 *
 *   `transition(orderId, event, metadata?)` is concurrency-safe at
 *   the b.fsm-instance level — but two replicas hitting the same
 *   order concurrently see ordering at the DB layer. The
 *   `order_transitions` insert + `orders.status` update happen in
 *   the same DB call sequence; a future `b.externalDb.transaction`
 *   wrap will tighten this further.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- FSM definition -----------------------------------------------------

var _orderFsm = null;
function _getOrderFsm() {
  if (_orderFsm) return _orderFsm;
  // b.fsm emits audit events under the 'fsm' namespace —
  // register it (idempotent) so the audit sink keeps the events
  // instead of dropping them with a noisy warning.
  try { _b().audit.registerNamespace("fsm"); } catch (_e) { /* idempotent; ignore */ }
  _orderFsm = _b().fsm.define({
    name:    "order",
    initial: "pending",
    states: {
      pending:    {},
      paid:       {},
      fulfilling: {},
      shipped:    {},
      delivered:  {},
      refunded:   {},
      cancelled:  {},
    },
    transitions: [
      { from: "pending",    to: "paid",       on: "mark_paid" },
      { from: "paid",       to: "fulfilling", on: "start_fulfillment" },
      { from: "fulfilling", to: "shipped",    on: "mark_shipped" },
      { from: "shipped",    to: "delivered",  on: "mark_delivered" },
      { from: "pending",    to: "cancelled",  on: "cancel" },
      { from: "paid",       to: "cancelled",  on: "cancel" },
      { from: "paid",       to: "refunded",   on: "refund" },
      { from: "fulfilling", to: "refunded",   on: "refund" },
      { from: "shipped",    to: "refunded",   on: "refund" },
      { from: "delivered",  to: "refunded",   on: "refund" },
    ],
  });
  return _orderFsm;
}

var TERMINAL_STATES = Object.freeze(["refunded", "cancelled", "delivered"]);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("order: " + label + " — " + (e && e.message || "invalid UUID")); }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("order: " + label + " must be a non-negative integer (minor units)");
  }
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("order: " + label + " must be a positive integer");
  }
}
function _currency(c) {
  if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("order: currency must be a 3-letter ISO 4217 code (uppercase)");
  }
}
function _shipTo(s) {
  if (!s || typeof s !== "object") throw new TypeError("order: ship_to must be an object");
  // Schema-light: country required, everything else operator-shaped.
  if (typeof s.country !== "string" || !/^[A-Z]{2}$/.test(s.country)) {
    throw new TypeError("order: ship_to.country must be a 2-letter ISO 3166-1 country code");
  }
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Optional outbound webhook dispatcher — when present, every
  // state transition fans out to operator-registered endpoints. The
  // dependency is opt-in so existing callers (and the test suite)
  // can run without standing up a webhooks primitive.
  var webhooks = opts.webhooks || null;

  return {
    TERMINAL_STATES: TERMINAL_STATES,

    // Build a new order from a cart + lines + totals. Caller passes
    // the cart, the resolved lines (with the price snapshots stored
    // on cart_lines), the totals object from `pricing.totals(...)`,
    // and ship-to. Optional `payment_intent_id` is set when payment
    // is wired before order creation (typical checkout flow).
    createFromCart: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("order.createFromCart: input object required");
      _uuid(input.cart_id, "cart_id");
      _uuid(input.session_id, "session_id"); // session_id is the cart's session — also UUID-shaped here
      if (input.customer_id) _uuid(input.customer_id, "customer_id");
      if (!Array.isArray(input.lines) || input.lines.length === 0) {
        throw new TypeError("order.createFromCart: lines must be a non-empty array");
      }
      _currency(input.currency);
      _nonNegInt(input.subtotal_minor,    "subtotal_minor");
      _nonNegInt(input.discount_minor,    "discount_minor");
      _nonNegInt(input.tax_minor,         "tax_minor");
      _nonNegInt(input.shipping_minor,    "shipping_minor");
      _nonNegInt(input.grand_total_minor, "grand_total_minor");
      _shipTo(input.ship_to);

      var id = _b().uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
        "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
        "payment_intent_id, ship_to_json, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        [
          id, input.cart_id, input.customer_id || null, input.session_id,
          input.currency, input.subtotal_minor, input.discount_minor,
          input.tax_minor, input.shipping_minor, input.grand_total_minor,
          input.payment_intent_id || null, JSON.stringify(input.ship_to), ts,
        ],
      );
      for (var i = 0; i < input.lines.length; i += 1) {
        var l = input.lines[i];
        _positiveInt(l.qty, "lines[" + i + "].qty");
        _nonNegInt(l.unit_amount_minor, "lines[" + i + "].unit_amount_minor");
        await query(
          "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, " +
          "unit_amount_minor, unit_currency, line_total_minor) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
          [
            _b().uuid.v7(), id, l.variant_id, l.sku, l.qty,
            l.unit_amount_minor, l.unit_currency || input.currency,
            l.qty * l.unit_amount_minor,
          ],
        );
      }
      // Initial transition row — from no-prior-state into pending.
      await query(
        "INSERT INTO order_transitions (id, order_id, from_state, to_state, on_event, reason, metadata_json, occurred_at) " +
        "VALUES (?1, ?2, '__init__', 'pending', 'create', ?3, '{}', ?4)",
        [_b().uuid.v7(), id, input.reason || null, ts],
      );
      return await this.get(id);
    },

    get: async function (id) {
      _uuid(id, "order id");
      var rows  = (await query("SELECT * FROM orders WHERE id = ?1", [id])).rows;
      if (!rows.length) return null;
      var order = rows[0];
      order.ship_to = JSON.parse(order.ship_to_json);
      order.lines = (await query("SELECT * FROM order_lines WHERE order_id = ?1 ORDER BY id ASC", [id])).rows;
      order.transitions = (await query("SELECT * FROM order_transitions WHERE order_id = ?1 ORDER BY occurred_at ASC", [id])).rows;
      return order;
    },

    byPaymentIntent: async function (paymentIntentId) {
      if (typeof paymentIntentId !== "string" || !paymentIntentId.length) {
        throw new TypeError("order.byPaymentIntent: paymentIntentId required");
      }
      var rows = (await query("SELECT * FROM orders WHERE payment_intent_id = ?1 LIMIT 1", [paymentIntentId])).rows;
      if (!rows.length) return null;
      return await this.get(rows[0].id);
    },

    // Fire a transition. Replays the FSM from the current state +
    // history, dispatches the event, and persists the new state on
    // the orders row + appends an order_transitions row.
    transition: async function (orderId, event, opts2) {
      _uuid(orderId, "order id");
      if (typeof event !== "string" || !event.length) throw new TypeError("order.transition: event must be a non-empty string");
      var current = (await query("SELECT * FROM orders WHERE id = ?1", [orderId])).rows[0];
      if (!current) throw new TypeError("order.transition: order " + orderId + " not found");
      // Rebuild the FSM instance at the current state by snapshot.
      var fsm = _getOrderFsm();
      var instance = fsm.restore({
        state:   current.status,
        history: [],
        context: {},
      });
      var result;
      try {
        result = await instance.transition(event, (opts2 && opts2.metadata) || null);
      } catch (e) {
        // b.fsm throws FsmError with .code on guard refusal / unknown
        // event / no transition from current state. Surface to caller.
        var err = new Error("order.transition: refused — " + (e && e.message || e));
        err.code = (e && e.code) || "ORDER_TRANSITION_REFUSED";
        err.cause = e;
        throw err;
      }
      var ts = _now();
      await query(
        "UPDATE orders SET status = ?1, updated_at = ?2 WHERE id = ?3",
        [result.to, ts, orderId],
      );
      await query(
        "INSERT INTO order_transitions (id, order_id, from_state, to_state, on_event, reason, metadata_json, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        [
          _b().uuid.v7(), orderId, result.from, result.to, event,
          (opts2 && opts2.reason) || null,
          JSON.stringify((opts2 && opts2.metadata) || {}),
          ts,
        ],
      );
      var refreshed = await this.get(orderId);
      // Fan-out to merchant webhook subscribers. The dispatch is
      // post-persist so a delivery failure can never roll back the
      // transition that just landed in the database. Errors from the
      // dispatcher are swallowed — the failure already lives in
      // `webhook_deliveries.last_error` for operator review.
      if (webhooks && typeof webhooks.send === "function") {
        try {
          await webhooks.send("order." + event, {
            order: refreshed,
            transition: {
              from:     result.from,
              to:       result.to,
              on_event: event,
              reason:   (opts2 && opts2.reason) || null,
              metadata: (opts2 && opts2.metadata) || {},
              occurred_at: ts,
            },
          });
        } catch (_e) { /* drop-silent — delivery rows hold the failure */ }
      }
      return refreshed;
    },

    setPaymentIntent: async function (orderId, paymentIntentId) {
      _uuid(orderId, "order id");
      if (typeof paymentIntentId !== "string" || !paymentIntentId.length) {
        throw new TypeError("order.setPaymentIntent: paymentIntentId required");
      }
      var ts = _now();
      var r = await query(
        "UPDATE orders SET payment_intent_id = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'pending'",
        [paymentIntentId, ts, orderId],
      );
      if (r.rowCount === 0) return null;
      return await this.get(orderId);
    },
  };
}

module.exports = {
  create:          create,
  TERMINAL_STATES: TERMINAL_STATES,
  // Exposed for the test suite to assert the FSM shape without
  // duplicating the definition.
  _getOrderFsm:    _getOrderFsm,
};
