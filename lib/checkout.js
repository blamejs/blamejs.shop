"use strict";
/**
 * @module shop.checkout
 * @title  Checkout orchestrator — cart → priced quote → confirm
 *
 * @intro
 *   Stateless orchestrator that ties the data primitives together:
 *   catalog, cart, pricing, tax, shipping, payment, order. The
 *   storefront / API handler calls two methods per checkout:
 *
 *     var quote = await checkout.quote({ cart_id, ship_to,
 *                                         selected_shipping_id });
 *     // → { lines, totals, shipping_rates, selected_shipping,
 *     //     tax_jurisdiction, currency }
 *
 *     var result = await checkout.confirm({
 *       cart_id, ship_to, selected_shipping_id,
 *       customer:           { email, name? },
 *       idempotency_key:    "<uuid>",   // caller-supplied; same key
 *                                       //   on retry is safe
 *     });
 *     // → { order, payment_intent: { id, client_secret, status } }
 *
 *   `quote()` is read-only — useful for the "review your order"
 *   page. `confirm()` is the transactional commit: creates the
 *   Stripe PaymentIntent, creates the order in `pending` state,
 *   marks the cart `converted`, returns the client_secret the
 *   storefront uses to drive Stripe.js / Payment Element.
 *
 *   The webhook handler completes the lifecycle:
 *
 *     var r = await checkout.handleStripeEvent({ headers, rawBody });
 *     // verifies sig, looks up order by payment_intent_id, fires
 *     // the appropriate FSM transition (mark_paid on succeeded,
 *     // refund on refunded, etc.).
 */

var b = require("./vendor/blamejs");

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("checkout: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _email(s) {
  try { return b.guardEmail.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("checkout: customer.email — " + (e && e.message || "invalid email")); }
}

function _shipTo(s) {
  if (!s || typeof s !== "object") throw new TypeError("checkout: ship_to must be an object");
  if (typeof s.country !== "string" || !/^[A-Z]{2}$/.test(s.country)) {
    throw new TypeError("checkout: ship_to.country must be a 2-letter ISO 3166-1 code");
  }
  if (s.state  && (typeof s.state  !== "string" || !/^[A-Z0-9]{1,5}$/.test(s.state))) {
    throw new TypeError("checkout: ship_to.state malformed");
  }
  if (s.postal && (typeof s.postal !== "string" || !/^[A-Za-z0-9 -]{1,16}$/.test(s.postal))) {
    throw new TypeError("checkout: ship_to.postal malformed");
  }
  return s;
}

// Map Stripe webhook event types → order FSM events. Unhandled
// types are skipped (handler returns `{ handled: false }`).
var STRIPE_EVENT_MAP = Object.freeze({
  "payment_intent.succeeded":         "mark_paid",
  "payment_intent.canceled":          "cancel",
  "payment_intent.payment_failed":    null,        // no state change — operator decides
  "charge.refunded":                  "refund",
});

// Subscription webhook event types route to the subscriptions
// primitive (if wired via deps.subscriptions) instead of the order
// FSM. The one-time-order path stays unchanged.
// PayPal webhook event types → order FSM event. The create/capture flow
// marks the order paid directly; these are the asynchronous backstop.
var PAYPAL_EVENT_MAP = Object.freeze({
  "PAYMENT.CAPTURE.COMPLETED": "mark_paid",
  "PAYMENT.CAPTURE.DENIED":    null,        // no state change — operator decides
  "PAYMENT.CAPTURE.REFUNDED":  "refund",
  "CHECKOUT.ORDER.APPROVED":   null,        // approved but not captured yet
});

var STRIPE_SUB_EVENT_TYPES = Object.freeze({
  "customer.subscription.created": true,
  "customer.subscription.updated": true,
  "customer.subscription.deleted": true,
});

function create(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("checkout.create: deps object required");
  ["catalog", "cart", "pricing", "tax", "shipping", "payment", "order"].forEach(function (k) {
    if (!deps[k]) throw new TypeError("checkout.create: deps." + k + " required");
  });
  var catalog       = deps.catalog;
  var cart          = deps.cart;
  var pricing       = deps.pricing;
  var tax           = deps.tax;
  var shipping      = deps.shipping;
  var payment       = deps.payment;
  var paypal        = deps.paypal || null;   // PayPal adapter — checkout-via-PayPal disabled when absent
  var order         = deps.order;
  var subscriptions = deps.subscriptions || null;
  // Optional — when wired, the buyer email is hashed (via the same
  // customers.hashEmail keying the customers table) and stored on the
  // order so a later verified-email sign-in can claim the guest order.
  var customers     = deps.customers || null;

  // Compose a quote from a cart + ship-to + (optional) selected
  // shipping service. Pure read — no DB writes.
  async function _buildQuote(input) {
    if (!input || typeof input !== "object") throw new TypeError("checkout.quote: input required");
    _uuid(input.cart_id, "cart_id");
    _shipTo(input.ship_to);

    var c = await cart.get(input.cart_id);
    if (!c)                       throw new TypeError("checkout: cart " + input.cart_id + " not found");
    if (c.status !== "active")    throw new TypeError("checkout: cart status is " + c.status + ", cannot quote");
    var lines = await cart.listLines(c.id);
    if (lines.length === 0)       throw new TypeError("checkout: cart is empty");

    // Variants for shipping weight + requires_shipping flag.
    var enrichedLines = [];
    for (var i = 0; i < lines.length; i += 1) {
      var v = await catalog.variants.get(lines[i].variant_id);
      enrichedLines.push(Object.assign({}, lines[i], {
        weight_grams:      v ? v.weight_grams      : 0,
        requires_shipping: v ? !!v.requires_shipping : true,
      }));
    }

    var sub = pricing.subtotal(lines, { currency: c.currency });
    var taxRow = await tax.calculate({
      shipTo:         input.ship_to,
      subtotal_minor: sub.amount_minor,
    });
    var ratesRow = await shipping.rates({
      shipTo:         input.ship_to,
      lines:          enrichedLines,
      subtotal_minor: sub.amount_minor,
    });

    var selected = null;
    if (input.selected_shipping_id) {
      for (var j = 0; j < ratesRow.services.length; j += 1) {
        if (ratesRow.services[j].id === input.selected_shipping_id) {
          selected = ratesRow.services[j];
          break;
        }
      }
      if (!selected) {
        throw new TypeError("checkout: selected_shipping_id " + JSON.stringify(input.selected_shipping_id) +
                            " not available for ship_to");
      }
    }

    var shippingMinor = selected ? selected.amount_minor : 0;
    var totals = pricing.totals(c, lines, {
      tax_minor:      taxRow.tax_minor,
      shipping_minor: shippingMinor,
      discount_minor: 0,
    });

    return {
      cart_id:           c.id,
      currency:          c.currency,
      lines:             enrichedLines,
      tax_jurisdiction:  taxRow.jurisdiction,
      tax_rate_bps:      taxRow.rate_bps,
      shipping_rates:    ratesRow.services,
      selected_shipping: selected,
      totals:            totals,
    };
  }

  return {
    STRIPE_EVENT_MAP: STRIPE_EVENT_MAP,

    quote: function (input) {
      return _buildQuote(input);
    },

    confirm: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("checkout.confirm: input required");
      if (!input.customer || typeof input.customer !== "object") throw new TypeError("checkout.confirm: customer required");
      var email = _email(input.customer.customer_email || input.customer.email);
      if (!input.selected_shipping_id) throw new TypeError("checkout.confirm: selected_shipping_id required");
      var idempotencyKey = input.idempotency_key;
      if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
        throw new TypeError("checkout.confirm: idempotency_key (≥8 chars) required");
      }

      var quote = await _buildQuote(input);
      if (!quote.selected_shipping) {
        // _buildQuote already threw above, but defense in depth.
        throw new TypeError("checkout.confirm: selected_shipping resolution returned null");
      }
      if (quote.totals.grand_total_minor <= 0) {
        throw new TypeError("checkout.confirm: grand_total_minor must be > 0 (zero-total orders use a separate freebie flow)");
      }

      // Create the PaymentIntent (idempotent via header).
      var pi = await payment.createPaymentIntent({
        amount_minor:  quote.totals.grand_total_minor,
        currency:      quote.currency.toLowerCase(),
        receipt_email: email,
        description:   "blamejs.shop order — cart " + quote.cart_id,
        metadata: {
          cart_id:        quote.cart_id,
          shipping_id:    quote.selected_shipping.id,
          subtotal_minor: String(quote.totals.subtotal_minor),
          tax_minor:      String(quote.totals.tax_minor),
          shipping_minor: String(quote.totals.shipping_minor),
        },
      }, idempotencyKey);

      // Create the local order in `pending` state with the PI linked.
      var cartRow = await cart.get(quote.cart_id);
      var createdOrder = await order.createFromCart({
        cart_id:            quote.cart_id,
        session_id:         cartRow.session_id,
        customer_id:        cartRow.customer_id || null,
        currency:           quote.currency,
        subtotal_minor:    quote.totals.subtotal_minor,
        discount_minor:    quote.totals.discount_minor,
        tax_minor:         quote.totals.tax_minor,
        shipping_minor:    quote.totals.shipping_minor,
        grand_total_minor: quote.totals.grand_total_minor,
        payment_intent_id: pi.id,
        ship_to:           input.ship_to,
        // Hash of the buyer email (same key as the customers table) so a
        // later verified-email sign-in can claim this guest order.
        customer_email_hash: customers ? customers.hashEmail(email) : null,
        lines:             quote.lines.map(function (l) {
          return {
            variant_id:        l.variant_id,
            sku:               l.sku,
            qty:               l.qty,
            unit_amount_minor: l.unit_amount_minor,
            unit_currency:     l.unit_currency,
          };
        }),
      });

      // Mark the cart converted so a refresh of the storefront
      // doesn't accidentally re-quote the same cart.
      await cart.setStatus(quote.cart_id, "converted");

      return {
        order: createdOrder,
        payment_intent: {
          id:            pi.id,
          client_secret: pi.client_secret,
          status:        pi.status,
        },
      };
    },

    // Verify a Stripe webhook payload and dispatch the order
    // transition. Returns { handled, order?, event_type }.
    handleStripeEvent: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("checkout.handleStripeEvent: input required");
      if (typeof input.rawBody !== "string") throw new TypeError("checkout.handleStripeEvent: rawBody (string) required");
      var v = await payment.verifyWebhook(input.headers || {}, input.rawBody);
      if (!v.ok) {
        var err = new Error("checkout: webhook signature invalid — " + v.reason);
        err.code = "WEBHOOK_INVALID";
        err.reason = v.reason;
        throw err;
      }
      var event = v.event;
      var eventType = event && event.type;

      // Subscription events route to the subscriptions primitive
      // (if wired). The one-time-order PaymentIntent path below
      // stays unchanged.
      if (eventType && Object.prototype.hasOwnProperty.call(STRIPE_SUB_EVENT_TYPES, eventType)) {
        if (!subscriptions) {
          return { handled: false, event_type: eventType, reason: "no-subscriptions-handler" };
        }
        return await subscriptions.handleStripeEvent(event);
      }

      if (!eventType || !Object.prototype.hasOwnProperty.call(STRIPE_EVENT_MAP, eventType)) {
        return { handled: false, event_type: eventType || null };
      }
      var fsmEvent = STRIPE_EVENT_MAP[eventType];
      if (!fsmEvent) return { handled: false, event_type: eventType, reason: "no-state-change" };

      // Extract payment_intent id from the event.
      var pi = null;
      if (event.data && event.data.object) {
        var obj = event.data.object;
        pi = obj.payment_intent || obj.id;
      }
      if (!pi) return { handled: false, event_type: eventType, reason: "no-payment-intent" };

      var o = await order.byPaymentIntent(pi);
      if (!o) return { handled: false, event_type: eventType, reason: "order-not-found" };

      // Idempotency: if the order is already in a state the event
      // would advance to, skip the transition (re-deliveries from
      // Stripe are common).
      var alreadyAdvanced = (
        (fsmEvent === "mark_paid"  && o.status !== "pending") ||
        (fsmEvent === "cancel"     && o.status === "cancelled") ||
        (fsmEvent === "refund"     && o.status === "refunded")
      );
      if (alreadyAdvanced) {
        return { handled: true, event_type: eventType, order: o, skipped: "already-advanced" };
      }

      var updated;
      try {
        updated = await order.transition(o.id, fsmEvent, {
          reason: "stripe:" + eventType,
          metadata: { stripe_event_id: event.id },
        });
      } catch (e) {
        // Illegal transition — bubble up.
        throw e;
      }
      return { handled: true, event_type: eventType, order: updated };
    },

    // ---- PayPal (Orders v2) ----------------------------------------------
    //
    // PayPal's flow is create → buyer-approve → capture, not a Stripe-style
    // PaymentIntent + webhook. `createPaypalOrder` prices the cart, opens a
    // PayPal order, and persists the local order in `pending` with the PayPal
    // order id linked. `capturePaypalOrder` (called after the buyer approves)
    // captures and advances the order to `paid`. `handlePaypalEvent` is the
    // async backstop. All three require the `paypal` adapter to be wired.

    createPaypalOrder: async function (input) {
      if (!paypal) throw new TypeError("checkout.createPaypalOrder: paypal adapter not wired");
      if (!input || typeof input !== "object") throw new TypeError("checkout.createPaypalOrder: input required");
      if (!input.customer || typeof input.customer !== "object") throw new TypeError("checkout.createPaypalOrder: customer required");
      var email = _email(input.customer.customer_email || input.customer.email);
      if (!input.selected_shipping_id) throw new TypeError("checkout.createPaypalOrder: selected_shipping_id required");
      var idempotencyKey = input.idempotency_key;
      if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
        throw new TypeError("checkout.createPaypalOrder: idempotency_key (≥8 chars) required");
      }
      var quote = await _buildQuote(input);
      if (quote.totals.grand_total_minor <= 0) {
        throw new TypeError("checkout.createPaypalOrder: grand_total_minor must be > 0");
      }
      var ppOrder = await paypal.createOrder({
        amount_minor: quote.totals.grand_total_minor,
        currency:     quote.currency.toUpperCase(),
        order_id:     quote.cart_id,
        return_url:   input.return_url || undefined,
        cancel_url:   input.cancel_url || undefined,
      }, idempotencyKey);
      var cartRow = await cart.get(quote.cart_id);
      var createdOrder = await order.createFromCart({
        cart_id:             quote.cart_id,
        session_id:          cartRow.session_id,
        customer_id:         cartRow.customer_id || null,
        currency:            quote.currency,
        subtotal_minor:      quote.totals.subtotal_minor,
        discount_minor:      quote.totals.discount_minor,
        tax_minor:           quote.totals.tax_minor,
        shipping_minor:      quote.totals.shipping_minor,
        grand_total_minor:   quote.totals.grand_total_minor,
        payment_intent_id:   ppOrder.id,   // the PayPal order id (opaque); links the webhook + capture
        ship_to:             input.ship_to,
        customer_email_hash: customers ? customers.hashEmail(email) : null,
        lines:               quote.lines.map(function (l) {
          return { variant_id: l.variant_id, sku: l.sku, qty: l.qty, unit_amount_minor: l.unit_amount_minor, unit_currency: l.unit_currency };
        }),
      });
      await cart.setStatus(quote.cart_id, "converted");
      return { order: createdOrder, paypal_order_id: ppOrder.id, status: ppOrder.status };
    },

    // Capture an approved PayPal order, then advance the local order to paid.
    // Idempotent: if the order already left `pending` (a webhook or a retry
    // beat us), the capture result is returned without a second transition.
    capturePaypalOrder: async function (paypalOrderId) {
      if (!paypal) throw new TypeError("checkout.capturePaypalOrder: paypal adapter not wired");
      if (typeof paypalOrderId !== "string" || !paypalOrderId.length) {
        throw new TypeError("checkout.capturePaypalOrder: paypalOrderId required");
      }
      var o = await order.byPaymentIntent(paypalOrderId);
      if (!o) return { handled: false, reason: "order-not-found", paypal_order_id: paypalOrderId };
      // Guard on LOCAL status before calling PayPal: if a prior capture or a
      // webhook already advanced the order, a second remote capture would be
      // rejected by PayPal (orders capture once) — turning an idempotent retry
      // into an exception. Treat already-advanced as a success no-op.
      if (o.status !== "pending") {
        return { handled: true, order: o, skipped: "already-advanced", paypal_order_id: paypalOrderId };
      }
      var cap = await paypal.captureOrder(paypalOrderId);
      var captureId = null;
      try { captureId = cap.purchase_units[0].payments.captures[0].id; } catch (_e) { captureId = null; }
      var completed = cap && (cap.status === "COMPLETED" ||
        (captureId && cap.purchase_units[0].payments.captures[0].status === "COMPLETED"));
      if (completed && o.status === "pending") {
        await order.transition(o.id, "mark_paid", {
          reason:   "paypal:capture",
          metadata: { paypal_order_id: paypalOrderId, paypal_capture_id: captureId },
        });
      }
      return { handled: !!completed, order: await order.get(o.id), capture_id: captureId, capture: cap };
    },

    // Verify a PayPal webhook (server-to-server, via the adapter) and apply
    // the matching order transition. The capture flow above is primary; this
    // catches captures completed/refunded out of band. { handled, ... }.
    handlePaypalEvent: async function (input) {
      if (!paypal) throw new TypeError("checkout.handlePaypalEvent: paypal adapter not wired");
      if (!input || typeof input !== "object") throw new TypeError("checkout.handlePaypalEvent: input required");
      if (typeof input.rawBody !== "string") throw new TypeError("checkout.handlePaypalEvent: rawBody (string) required");
      var v = await paypal.verifyWebhook(input.headers || {}, input.rawBody, { webhookId: input.webhookId });
      if (!v.ok) {
        var err = new Error("checkout: paypal webhook verification failed — " + v.reason);
        err.code = "WEBHOOK_INVALID";
        err.reason = v.reason;
        throw err;
      }
      var event = v.event || {};
      var eventType = event.event_type;
      if (!eventType || !Object.prototype.hasOwnProperty.call(PAYPAL_EVENT_MAP, eventType)) {
        return { handled: false, event_type: eventType || null };
      }
      var fsmEvent = PAYPAL_EVENT_MAP[eventType];
      if (!fsmEvent) return { handled: false, event_type: eventType, reason: "no-state-change" };
      // The PayPal order id lives in the capture resource's related ids.
      var ppOrderId = null;
      try { ppOrderId = event.resource.supplementary_data.related_ids.order_id; } catch (_e) { ppOrderId = null; }
      if (!ppOrderId) return { handled: false, event_type: eventType, reason: "no-order-id" };
      var o = await order.byPaymentIntent(ppOrderId);
      if (!o) return { handled: false, event_type: eventType, reason: "order-not-found" };
      var alreadyAdvanced = (
        (fsmEvent === "mark_paid" && o.status !== "pending") ||
        (fsmEvent === "refund"    && o.status === "refunded")
      );
      if (alreadyAdvanced) return { handled: true, event_type: eventType, order: o, skipped: "already-advanced" };
      var updated = await order.transition(o.id, fsmEvent, {
        reason:   "paypal:" + eventType,
        metadata: { paypal_event_id: event.id, paypal_order_id: ppOrderId },
      });
      return { handled: true, event_type: eventType, order: updated };
    },
  };
}

module.exports = {
  create:                 create,
  STRIPE_EVENT_MAP:       STRIPE_EVENT_MAP,
  STRIPE_SUB_EVENT_TYPES: STRIPE_SUB_EVENT_TYPES,
  PAYPAL_EVENT_MAP:       PAYPAL_EVENT_MAP,
};
