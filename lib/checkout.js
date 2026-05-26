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
  // Optional gift-card credit. `giftcards` owns the bearer credential
  // (lookup + the atomic balance decrement); `giftCardLedger` writes
  // the audit row. Gift-card redemption at checkout disables when
  // either is absent — the rest of the flow is unchanged.
  var giftcards     = deps.giftcards || null;
  var giftCardLedger = deps.giftCardLedger || null;
  // Optional loyalty points credit. When wired, a signed-in customer
  // can spend points at checkout for a storefront credit against the
  // grand total. `loyalty.balance` reads the spendable balance;
  // `loyalty.redeem` is the atomic debit (its `balance >= ?` SQL guard
  // is the authoritative double-spend defense). The redemption value is
  // derived from the ledger's own `REDEMPTION_POINTS_PER_USD` ratio so
  // checkout never re-derives the conversion constant. Disabled when
  // the handle is absent — the rest of the flow is unchanged.
  var loyalty       = deps.loyalty || null;

  // Validate a gift-card code against a priced quote: the card exists,
  // is active, not expired, and matches the order currency. Returns
  // the credit to apply (capped at the grand total so an order total
  // can never go negative) plus the resolved card row. Throws a
  // structured (non-TypeError) error on a code the customer typed that
  // can't be applied so callers surface a clean message; returns null
  // when no code was supplied or gift-card redemption isn't wired.
  async function _resolveGiftCard(code, quote) {
    if (code == null || code === "") return null;
    if (!giftcards) {
      var unwired = new Error("checkout: gift-card redemption is not configured");
      unwired.code = "GIFTCARD_NOT_CONFIGURED";
      throw unwired;
    }
    // _lookup throws TypeError on a malformed code (wrong length /
    // out-of-alphabet). Treat that as a generic "not recognized" so
    // the storefront never distinguishes "doesn't exist" from
    // "malformed" — both are the same dead end to a customer.
    var card;
    try {
      card = await giftcards.lookup(code);
    } catch (e) {
      if (e instanceof TypeError) card = null;
      else throw e;
    }
    if (!card) {
      var miss = new Error("checkout: gift card not recognized");
      miss.code = "GIFTCARD_NOT_FOUND";
      throw miss;
    }
    if (card.status !== "active") {
      var inactive = new Error("checkout: gift card is " + card.status);
      inactive.code = "GIFTCARD_NOT_ACTIVE";
      throw inactive;
    }
    if (card.expires_at != null && card.expires_at <= Date.now()) {
      var expired = new Error("checkout: gift card is expired");
      expired.code = "GIFTCARD_EXPIRED";
      throw expired;
    }
    if (card.currency !== quote.currency) {
      var mismatch = new Error("checkout: gift card currency " + card.currency +
                               " does not match order currency " + quote.currency);
      mismatch.code = "GIFTCARD_CURRENCY_MISMATCH";
      throw mismatch;
    }
    // Credit is the lesser of the card balance and the grand total —
    // a card worth more than the order leaves the remainder on the
    // card; a card worth less reduces the amount due, never below 0.
    var grand = quote.totals.grand_total_minor;
    var applied = card.balance_minor < grand ? card.balance_minor : grand;
    // `code_plain` is the bearer code the redeem decrement re-hashes;
    // it lives only in this in-memory resolution, never persisted.
    return { card: card, code_plain: code, applied_minor: applied, balance_minor: card.balance_minor };
  }

  // Burn the resolved credit against the created order. The
  // `giftcards.redeem` decrement is the authoritative double-spend
  // guard — its `balance_minor >= ?` SQL predicate refuses a second
  // spend that would overdraw, and a re-quote of the same card on a
  // new order only ever debits the remaining balance. The ledger
  // debit rides alongside as the operator-facing audit row, keyed on
  // the order id. Called once per order, immediately after the order
  // row exists, so a card is never burned for an order that failed to
  // create.
  async function _redeemGiftCard(resolved, orderId) {
    var redemption = await giftcards.redeem({
      code:         resolved.code_plain,
      order_id:     orderId,
      amount_minor: resolved.applied_minor,
    });
    if (giftCardLedger) {
      await giftCardLedger.debit({
        gift_card_id: resolved.card.id,
        order_id:     orderId,
        amount_minor: resolved.applied_minor,
      });
    }
    return redemption;
  }

  // Resolve an optional loyalty points credit against a priced quote.
  // `points` is the number of points the customer asked to spend;
  // `customerId` is the signed-in customer's UUID (a guest cart has
  // none — loyalty redemption needs an account, so a points request on
  // a guest order is refused). Returns the credit to apply (the points
  // converted to minor units via the ledger's redemption ratio, then
  // capped at the grand total so a customer can't redeem more value
  // than the order is worth) plus the integer points that credit
  // actually consumes. Throws a structured (non-TypeError) error on a
  // request that can't be honored so callers surface a clean re-prompt;
  // returns null when no points were requested or loyalty isn't wired.
  //
  // Capping in points-space (not minor-units) matters: redeeming 250
  // points worth $2.50 against a $1.00 order should debit only the 100
  // points the $1.00 credit consumes, leaving the remaining 150 points
  // in the balance — never silently burning the surplus.
  async function _resolveLoyaltyCredit(points, customerId, quote) {
    if (points == null) return null;
    if (!Number.isInteger(points) || points <= 0) {
      var bad = new Error("checkout: loyalty_redeem_points must be a positive integer");
      bad.code = "LOYALTY_REDEEM_INVALID";
      throw bad;
    }
    if (!loyalty) {
      var unwired = new Error("checkout: loyalty redemption is not configured");
      unwired.code = "LOYALTY_NOT_CONFIGURED";
      throw unwired;
    }
    if (!customerId) {
      var guest = new Error("checkout: sign in to redeem loyalty points");
      guest.code = "LOYALTY_REQUIRES_ACCOUNT";
      throw guest;
    }
    var perUsd = loyalty.REDEMPTION_POINTS_PER_USD;
    var bal = await loyalty.balance(customerId);
    if (bal.balance < points) {
      var insuff = new Error("checkout: loyalty balance is " + bal.balance + ", cannot redeem " + points);
      insuff.code = "LOYALTY_INSUFFICIENT_BALANCE";
      throw insuff;
    }
    // Value the requested points in minor units, then cap at the grand
    // total. The applied minor-units are floored to a whole point's
    // worth so the points actually debited map exactly to the credit
    // granted (no fractional-point credit).
    var grand = quote.totals.grand_total_minor;
    var requestedMinor = Math.floor((points * 100) / perUsd);
    var appliedMinor = requestedMinor < grand ? requestedMinor : grand;
    if (appliedMinor <= 0) {
      var tooFew = new Error("checkout: " + points + " points is worth less than the minimum redeemable credit");
      tooFew.code = "LOYALTY_REDEEM_TOO_SMALL";
      throw tooFew;
    }
    // Points the applied credit actually consumes — re-derived from the
    // capped minor-units so a partial cap only spends the points the
    // granted credit is worth.
    var spentPoints = Math.ceil((appliedMinor * perUsd) / 100);
    if (spentPoints > points) spentPoints = points;          // floor/ceil guard — never spend more than asked
    return { points: spentPoints, applied_minor: appliedMinor };
  }

  // Burn the resolved loyalty credit against the created order. The
  // `loyalty.redeem` decrement is the authoritative double-spend guard
  // (its `balance_points >= ?` SQL predicate refuses an overdraw), and
  // the `order_id` link records the redemption against the order in the
  // loyalty audit trail. Called once per order, after the order row
  // exists, so points are never spent for an order that failed to
  // create.
  async function _redeemLoyalty(resolved, customerId, orderId) {
    await loyalty.redeem({
      customer_id: customerId,
      points:      resolved.points,
      order_id:    orderId,
      notes:       "checkout-credit:" + orderId,
    });
  }

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

      // Resolve an optional gift-card credit BEFORE any charge so a
      // bad code fails the checkout without touching Stripe. The
      // credit reduces the amount due; the order still records the
      // full grand total it owed.
      var gc = await _resolveGiftCard(input.gift_card_code, quote);
      // Loyalty points credit stacks on top of any gift-card credit —
      // both reduce the same amount due. The loyalty credit is capped
      // at the grand total inside the resolver, but since the gift card
      // may already cover part of the order, cap the loyalty credit
      // again at what's still due so the two credits together never
      // drive the amount due below zero.
      var cartRowForCustomer = await cart.get(quote.cart_id);
      var loyaltyCustomerId = cartRowForCustomer ? (cartRowForCustomer.customer_id || null) : null;
      var loy = await _resolveLoyaltyCredit(input.loyalty_redeem_points, loyaltyCustomerId, quote);
      var afterGiftCard = quote.totals.grand_total_minor - (gc ? gc.applied_minor : 0);
      if (loy && loy.applied_minor > afterGiftCard) {
        // The gift card already covers more of the order than the
        // points were valued against — re-cap the points credit to the
        // residual so the two never overlap. Re-derive the spent points
        // from the smaller credit so surplus points stay in the balance.
        loy.applied_minor = afterGiftCard < 0 ? 0 : afterGiftCard;
        var perUsd = loyalty.REDEMPTION_POINTS_PER_USD;
        loy.points = Math.ceil((loy.applied_minor * perUsd) / 100);
        if (loy.applied_minor <= 0) loy = null;
      }
      var amountDue = afterGiftCard - (loy ? loy.applied_minor : 0);

      var orderLines = quote.lines.map(function (l) {
        return {
          variant_id:        l.variant_id,
          sku:               l.sku,
          qty:               l.qty,
          unit_amount_minor: l.unit_amount_minor,
          unit_currency:     l.unit_currency,
        };
      });
      // Reuse the cart row already fetched for the loyalty
      // customer-id lookup above — one read, not two.
      var cartRow = cartRowForCustomer;
      // Hash of the buyer email (same key as the customers table) so a
      // later verified-email sign-in can claim this guest order.
      var emailHash = customers ? customers.hashEmail(email) : null;

      // Zero amount due — gift-card + loyalty credit fully cover the
      // order. No PaymentIntent (Stripe refuses a zero-amount intent);
      // create the order, burn the credits against it, and advance it
      // straight to paid via the FSM.
      if (amountDue === 0) {
        var paidOrder = await order.createFromCart({
          cart_id:            quote.cart_id,
          session_id:         cartRow.session_id,
          customer_id:        cartRow.customer_id || null,
          currency:           quote.currency,
          subtotal_minor:    quote.totals.subtotal_minor,
          discount_minor:    quote.totals.discount_minor,
          tax_minor:         quote.totals.tax_minor,
          shipping_minor:    quote.totals.shipping_minor,
          grand_total_minor: quote.totals.grand_total_minor,
          payment_intent_id: null,
          ship_to:           input.ship_to,
          customer_email_hash: emailHash,
          lines:             orderLines,
        });
        if (gc) await _redeemGiftCard(gc, paidOrder.id);
        if (loy) await _redeemLoyalty(loy, loyaltyCustomerId, paidOrder.id);
        await cart.setStatus(quote.cart_id, "converted");
        var settled = await order.transition(paidOrder.id, "mark_paid", {
          reason: loy && !gc ? "loyalty:full" : "gift_card:full",
        });
        return {
          order: settled,
          payment_intent: null,
          gift_card: gc ? { applied_minor: gc.applied_minor, amount_due_minor: 0 } : null,
          loyalty: loy ? { points: loy.points, applied_minor: loy.applied_minor, amount_due_minor: 0 } : null,
        };
      }

      // Create the PaymentIntent for the amount DUE after the credit
      // (idempotent via header).
      var pi = await payment.createPaymentIntent({
        amount_minor:  amountDue,
        currency:      quote.currency.toLowerCase(),
        receipt_email: email,
        description:   "blamejs.shop order — cart " + quote.cart_id,
        metadata: {
          cart_id:        quote.cart_id,
          shipping_id:    quote.selected_shipping.id,
          subtotal_minor: String(quote.totals.subtotal_minor),
          tax_minor:      String(quote.totals.tax_minor),
          shipping_minor: String(quote.totals.shipping_minor),
          gift_card_applied_minor: String(gc ? gc.applied_minor : 0),
          loyalty_applied_minor:   String(loy ? loy.applied_minor : 0),
        },
      }, idempotencyKey);

      // Create the local order in `pending` state with the PI linked.
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
        customer_email_hash: emailHash,
        lines:             orderLines,
      });

      // Burn the gift-card + loyalty credits against the created order.
      // Runs after the order row exists so a failed order never spends
      // either credit; each redeem decrement is its own double-spend
      // guard.
      if (gc) await _redeemGiftCard(gc, createdOrder.id);
      if (loy) await _redeemLoyalty(loy, loyaltyCustomerId, createdOrder.id);

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
        gift_card: gc ? { applied_minor: gc.applied_minor, amount_due_minor: amountDue } : null,
        loyalty: loy ? { points: loy.points, applied_minor: loy.applied_minor, amount_due_minor: amountDue } : null,
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
      // Resolve an optional gift-card credit before opening the PayPal
      // order so a bad code fails without a remote round-trip.
      var gc = await _resolveGiftCard(input.gift_card_code, quote);
      var amountDue = quote.totals.grand_total_minor - (gc ? gc.applied_minor : 0);
      var cartRow = await cart.get(quote.cart_id);
      var emailHash = customers ? customers.hashEmail(email) : null;
      var ppLines = quote.lines.map(function (l) {
        return { variant_id: l.variant_id, sku: l.sku, qty: l.qty, unit_amount_minor: l.unit_amount_minor, unit_currency: l.unit_currency };
      });

      // Gift card fully covers the order — no PayPal order (PayPal
      // refuses a zero-amount order). Create + burn + mark paid, same
      // as the Stripe full-coverage path.
      if (amountDue === 0) {
        var paidOrder = await order.createFromCart({
          cart_id:             quote.cart_id,
          session_id:          cartRow.session_id,
          customer_id:         cartRow.customer_id || null,
          currency:            quote.currency,
          subtotal_minor:      quote.totals.subtotal_minor,
          discount_minor:      quote.totals.discount_minor,
          tax_minor:           quote.totals.tax_minor,
          shipping_minor:      quote.totals.shipping_minor,
          grand_total_minor:   quote.totals.grand_total_minor,
          payment_intent_id:   null,
          ship_to:             input.ship_to,
          customer_email_hash: emailHash,
          lines:               ppLines,
        });
        await _redeemGiftCard(gc, paidOrder.id);
        await cart.setStatus(quote.cart_id, "converted");
        var settled = await order.transition(paidOrder.id, "mark_paid", { reason: "gift_card:full" });
        return { order: settled, paypal_order_id: null, status: "PAID_BY_GIFT_CARD", gift_card: { applied_minor: gc.applied_minor, amount_due_minor: 0 } };
      }

      var ppOrder = await paypal.createOrder({
        amount_minor: amountDue,
        currency:     quote.currency.toUpperCase(),
        order_id:     quote.cart_id,
        return_url:   input.return_url || undefined,
        cancel_url:   input.cancel_url || undefined,
      }, idempotencyKey);
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
        customer_email_hash: emailHash,
        lines:               ppLines,
      });
      if (gc) await _redeemGiftCard(gc, createdOrder.id);
      await cart.setStatus(quote.cart_id, "converted");
      return { order: createdOrder, paypal_order_id: ppOrder.id, status: ppOrder.status, gift_card: gc ? { applied_minor: gc.applied_minor, amount_due_minor: amountDue } : null };
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
