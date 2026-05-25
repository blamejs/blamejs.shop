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

var b = require("./index").framework;

// ---- FSM definition -----------------------------------------------------

var _orderFsm = null;
// The order lifecycle, as edges of the FSM. Single source of truth: the
// FSM definition below is built from it, and the operator console derives
// the available actions for an order from it (so a new edge here lights up
// a button in /admin/orders with no separate map to keep in sync).
var ORDER_TRANSITIONS = Object.freeze([
  { from: "pending",    to: "paid",       on: "mark_paid",         label: "Mark paid" },
  { from: "paid",       to: "fulfilling", on: "start_fulfillment", label: "Start fulfilment" },
  { from: "fulfilling", to: "shipped",    on: "mark_shipped",      label: "Mark shipped" },
  { from: "shipped",    to: "delivered",  on: "mark_delivered",    label: "Mark delivered" },
  { from: "pending",    to: "cancelled",  on: "cancel",            label: "Cancel" },
  { from: "paid",       to: "cancelled",  on: "cancel",            label: "Cancel" },
  { from: "paid",       to: "refunded",   on: "refund",            label: "Refund" },
  { from: "fulfilling", to: "refunded",   on: "refund",            label: "Refund" },
  { from: "shipped",    to: "refunded",   on: "refund",            label: "Refund" },
  { from: "delivered",  to: "refunded",   on: "refund",            label: "Refund" },
]);

function _getOrderFsm() {
  if (_orderFsm) return _orderFsm;
  // b.fsm emits audit events under the 'fsm' namespace —
  // register it (idempotent) so the audit sink keeps the events
  // instead of dropping them with a noisy warning.
  try { b.audit.registerNamespace("fsm"); } catch (_e) { /* idempotent; ignore */ }
  _orderFsm = b.fsm.define({
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
    transitions: ORDER_TRANSITIONS.map(function (t) {
      return { from: t.from, to: t.to, on: t.on };
    }),
  });
  return _orderFsm;
}

var TERMINAL_STATES = Object.freeze(["refunded", "cancelled", "delivered"]);

// Every state the order FSM can occupy — the allowed values for the
// `status` filter on the operator-facing recent-orders list.
var ORDER_STATES = Object.freeze([
  "pending", "paid", "fulfilling", "shipped", "delivered", "refunded", "cancelled",
]);

// Cursor key for listForCustomer — paginates by (updated_at DESC, id
// DESC) so a newly transitioned order surfaces at the top of the
// customer's order history without a stable-id tie-break flake.
var ORDER_ORDER_KEY = ["updated_at:desc", "id:desc"];
var MAX_LIST_LIMIT = 100;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
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
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional outbound webhook dispatcher — when present, every
  // state transition fans out to operator-registered endpoints. The
  // dependency is opt-in so existing callers (and the test suite)
  // can run without standing up a webhooks primitive.
  var webhooks = opts.webhooks || null;
  // Pagination cursors for listForCustomer are HMAC-tagged via
  // b.pagination so an operator can't hand-craft one to skip past a
  // hidden order or replay across deployments. The secret defaults
  // to a dev-only placeholder so the primitive boots in tests; the
  // deployment is expected to supply a derived value (typically
  // b.crypto.namespaceHash("order-cursor", D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("order.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "order-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

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

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
        "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
        "payment_intent_id, ship_to_json, customer_email_hash, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
        [
          id, input.cart_id, input.customer_id || null, input.session_id,
          input.currency, input.subtotal_minor, input.discount_minor,
          input.tax_minor, input.shipping_minor, input.grand_total_minor,
          input.payment_intent_id || null, JSON.stringify(input.ship_to),
          input.customer_email_hash || null, ts,
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
            b.uuid.v7(), id, l.variant_id, l.sku, l.qty,
            l.unit_amount_minor, l.unit_currency || input.currency,
            l.qty * l.unit_amount_minor,
          ],
        );
      }
      // Initial transition row — from no-prior-state into pending.
      await query(
        "INSERT INTO order_transitions (id, order_id, from_state, to_state, on_event, reason, metadata_json, occurred_at) " +
        "VALUES (?1, ?2, '__init__', 'pending', 'create', ?3, '{}', ?4)",
        [b.uuid.v7(), id, input.reason || null, ts],
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
          b.uuid.v7(), orderId, result.from, result.to, event,
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

    // Paginated history for a single customer. Tuple cursor
    // (updated_at, id) ordered DESC so the customer's most-recent
    // activity surfaces first. Mirrors the cursor shape used by
    // catalog.products.list — same HMAC tag, same orderKey
    // mismatch-on-tamper refusal. Row payloads include `lines` so
    // the storefront can render a useful summary without a second
    // per-row fetch.
    listForCustomer: async function (customerId, listOpts) {
      _uuid(customerId, "customer id");
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? 20 : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
        throw new TypeError("order.listForCustomer: limit must be 1..." + MAX_LIST_LIMIT);
      }
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("order.listForCustomer: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(ORDER_ORDER_KEY)) {
            throw new TypeError("order.listForCustomer: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("order.listForCustomer: cursor — " + (e && e.message || "malformed"));
        }
      }
      var sql, params;
      if (cursorVals) {
        sql = "SELECT * FROM orders WHERE customer_id = ?1 AND " +
              "(updated_at < ?2 OR (updated_at = ?2 AND id < ?3)) " +
              "ORDER BY updated_at DESC, id DESC LIMIT ?4";
        params = [customerId, cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM orders WHERE customer_id = ?1 " +
              "ORDER BY updated_at DESC, id DESC LIMIT ?2";
        params = [customerId, limit];
      }
      var rows = (await query(sql, params)).rows;
      // Hydrate ship_to_json + lines on each row so the renderer
      // doesn't need a separate trip per order.
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].ship_to = JSON.parse(rows[i].ship_to_json);
        rows[i].lines   = (await query(
          "SELECT * FROM order_lines WHERE order_id = ?1 ORDER BY id ASC",
          [rows[i].id],
        )).rows;
      }
      var last = rows[rows.length - 1];
      var next = null;
      if (last && rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: ORDER_ORDER_KEY,
          vals:     [last.updated_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, next_cursor: next };
    },

    // Operator-facing recent-orders list across ALL customers (guest
    // orders included), newest first. Unlike listForCustomer this is an
    // admin view, so it's capped + uncursored: the console shows the most
    // recent N, optionally filtered to one status. ship_to + lines are
    // hydrated so the table renders without a trip per row.
    listRecent: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
        throw new TypeError("order.listRecent: limit must be 1..." + MAX_LIST_LIMIT);
      }
      var status = listOpts.status == null ? null : listOpts.status;
      if (status !== null) {
        if (typeof status !== "string" || ORDER_STATES.indexOf(status) === -1) {
          throw new TypeError("order.listRecent: status must be one of " + ORDER_STATES.join(", "));
        }
      }
      var sql, params;
      if (status) {
        sql = "SELECT * FROM orders WHERE status = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2";
        params = [status, limit];
      } else {
        sql = "SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT ?1";
        params = [limit];
      }
      var rows = (await query(sql, params)).rows;
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].ship_to = JSON.parse(rows[i].ship_to_json);
        rows[i].lines   = (await query(
          "SELECT * FROM order_lines WHERE order_id = ?1 ORDER BY id ASC",
          [rows[i].id],
        )).rows;
      }
      return { rows: rows };
    },

    // The actions available from a given status, as {on, to, label} —
    // drives the transition buttons on the operator order-detail page.
    // A terminal status returns []. Synchronous (pure lookup).
    transitionsFrom: function (status) {
      return ORDER_TRANSITIONS.filter(function (t) { return t.from === status; })
        .map(function (t) { return { on: t.on, to: t.to, label: t.label }; });
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

    // Claim guest orders into a customer account by matching the
    // recorded buyer-email hash. The CALLER must only pass a hash for an
    // email the identity provider VERIFIED — this method does not (and
    // cannot) re-verify; linking an unverified email would be account
    // takeover. Only touches orders with no owner yet (customer_id IS
    // NULL), so it never re-assigns another customer's order. Returns
    // the count linked.
    linkGuestOrdersByEmailHash: async function (customerId, emailHash) {
      _uuid(customerId, "customer id");
      if (typeof emailHash !== "string" || !emailHash.length) {
        throw new TypeError("order.linkGuestOrdersByEmailHash: emailHash must be a non-empty string");
      }
      var r = await query(
        "UPDATE orders SET customer_id = ?1, updated_at = ?2 " +
        "WHERE customer_id IS NULL AND customer_email_hash = ?3",
        [customerId, _now(), emailHash],
      );
      return Number(r.rowCount || 0);
    },

    // Has this customer purchased this product? True iff an order
    // line for any variant of the product sits in an order owned by
    // the customer whose status is a real purchase — anything except
    // pending (never captured) or cancelled (reversed before
    // fulfillment). paid|fulfilling|shipped|delivered|refunded all
    // count as purchased. The review gate composes this so only
    // verified buyers can leave a review. Existence check, one round
    // trip.
    hasPurchasedProduct: async function (customerId, productId) {
      _uuid(customerId, "customer id");
      _uuid(productId, "product id");
      var rows = (await query(
        "SELECT 1 FROM order_lines ol " +
        "JOIN orders o   ON o.id = ol.order_id " +
        "JOIN variants v ON v.id = ol.variant_id " +
        "WHERE o.customer_id = ?1 AND v.product_id = ?2 " +
        "AND o.status NOT IN ('pending','cancelled') " +
        "LIMIT 1",
        [customerId, productId],
      )).rows;
      return rows.length > 0;
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
