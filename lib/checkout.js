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

// ---- address format validation -------------------------------------------
//
// ISO 3166-1 alpha-2 validity via the platform Intl data (zero-dep): an
// assigned region code resolves to a display name, an unknown one round-
// trips unchanged, so the `.of()` echo test distinguishes them. CLDR also
// names a handful of reserved/sentinel codes that are NOT assigned ISO
// 3166-1 countries (ZZ "Unknown Region", UK/EU/EZ/UN/SU/FX, the XA/XB
// pseudo-locales, QO) — deny-listed below so a shopper typing "UK" gets
// the crisp field error pointing at GB instead of a confusing no-
// shipping-zone failure later. XK (Kosovo, user-assigned) stays accepted
// — it ships. Memoized — one formatter per process. Falls back to the
// shape check if Intl region data is unavailable so checkout never
// hard-fails on a stripped ICU build.
var _NON_ISO_REGION = Object.freeze({
  ZZ: 1, UK: 1, EU: 1, EZ: 1, UN: 1, SU: 1, FX: 1, XA: 1, XB: 1, QO: 1,
});
var _regionNames = null;
function _isIsoCountry(cc) {
  if (typeof cc !== "string" || !/^[A-Z]{2}$/.test(cc)) return false;
  if (_NON_ISO_REGION[cc]) return false;
  try {
    if (!_regionNames) _regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    return _regionNames.of(cc) !== cc; // unknown codes echo the input back
  } catch (_e) {
    return true; // Intl region data unavailable → shape-only validation
  }
}

// USPS state/territory and Canada Post province/territory codes, plus the
// two countries' postal formats. Format validation tightens ONLY for these
// two well-known sets; every other destination keeps the lenient length-
// bounded checks — international address formats defy tight rules, and
// over-validating them locks real customers out of checkout.
var _US_STATES = Object.freeze({
  AL: 1, AK: 1, AZ: 1, AR: 1, CA: 1, CO: 1, CT: 1, DE: 1, DC: 1, FL: 1,
  GA: 1, HI: 1, ID: 1, IL: 1, IN: 1, IA: 1, KS: 1, KY: 1, LA: 1, ME: 1,
  MD: 1, MA: 1, MI: 1, MN: 1, MS: 1, MO: 1, MT: 1, NE: 1, NV: 1, NH: 1,
  NJ: 1, NM: 1, NY: 1, NC: 1, ND: 1, OH: 1, OK: 1, OR: 1, PA: 1, RI: 1,
  SC: 1, SD: 1, TN: 1, TX: 1, UT: 1, VT: 1, VA: 1, WA: 1, WV: 1, WI: 1,
  WY: 1, AS: 1, GU: 1, MP: 1, PR: 1, VI: 1,
});
var _CA_PROVINCES = Object.freeze({
  AB: 1, BC: 1, MB: 1, NB: 1, NL: 1, NS: 1, NT: 1, NU: 1, ON: 1, PE: 1,
  QC: 1, SK: 1, YT: 1,
});
var _US_ZIP = /^\d{5}(-\d{4})?$/;
var _CA_POSTAL = /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/;

function _shipTo(s) {
  if (!s || typeof s !== "object") throw new TypeError("checkout: ship_to must be an object");
  if (typeof s.country !== "string" || !_isIsoCountry(s.country)) {
    throw new TypeError("checkout: ship_to.country — Enter a valid two-letter country code (e.g. US, GB).");
  }
  // US + Canada get real region-code and postal-format validation when the
  // fields are present; presence itself is the storefront form's contract
  // (a digital-only order legitimately carries a bare country). The
  // messages are customer-facing — the checkout form echoes them on the
  // rejected field.
  if (s.country === "US" || s.country === "CA") {
    var regionCodes = s.country === "US" ? _US_STATES : _CA_PROVINCES;
    if (s.state && (typeof s.state !== "string" || !Object.prototype.hasOwnProperty.call(regionCodes, s.state))) {
      throw new TypeError(s.country === "US"
        ? "checkout: ship_to.state — Enter a valid US state or territory code (e.g. CA)."
        : "checkout: ship_to.state — Enter a valid Canadian province code (e.g. ON).");
    }
    if (s.postal && (typeof s.postal !== "string" || !(s.country === "US" ? _US_ZIP : _CA_POSTAL).test(s.postal))) {
      throw new TypeError(s.country === "US"
        ? "checkout: ship_to.postal — Enter a valid ZIP code (12345 or 12345-6789)."
        : "checkout: ship_to.postal — Enter a valid postal code (A1A 1A1).");
    }
  } else {
    if (s.state  && (typeof s.state  !== "string" || !/^[A-Za-z0-9 .-]{1,32}$/.test(s.state))) {
      throw new TypeError("checkout: ship_to.state — Enter a valid state / province code.");
    }
    if (s.postal && (typeof s.postal !== "string" || !/^[A-Za-z0-9 -]{1,16}$/.test(s.postal))) {
      throw new TypeError("checkout: ship_to.postal — Enter a valid postal code.");
    }
  }
  // Street address + city are free-text (international addresses defy a
  // tight character class), so validation is shape + length only. They
  // are optional at this layer — a digital-only order ships nothing —
  // and length-capped so a stored value can't bloat the order row; the
  // values are HTML-escaped wherever they render (confirmation, admin,
  // export). The checkout form marks line1 + city required so the
  // common physical-goods path collects a complete address.
  if (s.line1 && (typeof s.line1 !== "string" || s.line1.length > 200)) {
    throw new TypeError("checkout: ship_to.line1 — Enter a street address of 200 characters or fewer.");
  }
  if (s.line2 && (typeof s.line2 !== "string" || s.line2.length > 200)) {
    throw new TypeError("checkout: ship_to.line2 — Enter an apt / suite of 200 characters or fewer.");
  }
  if (s.city  && (typeof s.city  !== "string" || s.city.length  > 120)) {
    throw new TypeError("checkout: ship_to.city — Enter a city of 120 characters or fewer.");
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
  // Optional quantity-discount engine. When wired, each cart line is
  // repriced at confirm/quote time by reapplying the active per-line
  // quantity break at the line's current quantity, so the order total
  // (and the per-line price written onto the order) reflects the break
  // — never the bare add-time snapshot. Disabled when absent: lines
  // pass through at their snapshot price. The repricing is the same
  // server-authoritative computation the cart page renders, so the
  // "review your order" subtotal and the charged amount agree.
  var quantityDiscounts = deps.quantityDiscounts || null;
  // Optional automatic-discount engine. When wired, the quote consults
  // every operator-authored auto-discount rule against the resolved
  // cart and reduces the subtotal by the matched savings (clamped to
  // [0, subtotal] so a rule can never drive the order negative or
  // charge more than the cart is worth). Disabled when absent — the
  // discount is zero and every total is identical to the un-wired
  // flow, so production stays unchanged until a rule is defined. Only
  // subtotal-reducing savings feed `discount_minor`; a `free_shipping`
  // rule's savings are a shipping concern and are left to the shipping
  // primitive, not folded into the subtotal discount here.
  var autoDiscount  = deps.autoDiscount || null;
  // Optional discount-allocation recorder. When wired, a placed order
  // that carried a cart-level discount gets a per-line breakdown of how
  // that discount split across the order lines, recorded as a back-office
  // audit row so a later partial refund knows each line's discounted
  // share. POST-COMMIT + drop-silent: it runs after the order exists, in
  // its own try/catch, so a recording failure can never fail, reverse, or
  // change the charge of a placed order. No discount -> nothing recorded.
  // Disabled when absent — the buy path is byte-identical to the un-wired
  // flow.
  var discountAllocation = deps.discountAllocation || null;

  // Reprice a list of cart lines through the quantity-discount engine.
  // Returns a shallow copy with `unit_amount_minor` overwritten by the
  // discounted unit for each line's SKU at its quantity. A line whose
  // SKU has no active tier (or any apply failure) keeps its snapshot.
  // No-op pass-through when the engine isn't wired.
  async function _repriceLines(c, lines) {
    if (!quantityDiscounts) return lines;
    var out = [];
    for (var i = 0; i < lines.length; i += 1) {
      var l = lines[i];
      var unit = l.unit_amount_minor;
      try {
        var v = await catalog.variants.get(l.variant_id);
        var applied = await quantityDiscounts.applyToLine({
          line: {
            sku:              l.sku,
            quantity:         l.qty,
            unit_price_minor: l.unit_amount_minor,
            product_id:       v ? v.product_id : undefined,
          },
        });
        unit = applied.discounted_unit_minor;
      } catch (_e) {
        // Unpriceable line keeps its snapshot — the quantity-break is
        // an adjustment, never a hard gate on the buy path.
        unit = l.unit_amount_minor;
      }
      out.push(Object.assign({}, l, { unit_amount_minor: unit }));
    }
    return out;
  }

  // Resolve the automatic-discount effect for a priced cart. Builds
  // the engine's cart shape from the resolved lines + subtotal, asks
  // the engine which operator-authored rules apply, and returns the
  // subtotal-reducing savings (clamped to [0, subtotal]) plus the
  // per-rule breakdown the post-commit recorder replays.
  //
  // FALLBACK (zero regression): no engine wired, a non-finite or
  // negative aggregate, an empty result, or ANY throw collapses to
  // `{ discount_minor: 0, applied: [] }` — byte-identical to the
  // un-wired flow. The engine is consulted but never trusted to keep
  // the buy path alive.
  //
  // PAYMENT SAFETY: the returned discount is clamped to
  // [0, subtotalMinor] so it can never be negative and never exceeds
  // the subtotal — the order total can therefore never go negative,
  // and a customer can never be charged less than zero or credited
  // more than the cart is worth.
  async function _resolveAutoDiscount(lines, subtotalMinor, customerId, codes) {
    if (!autoDiscount || typeof autoDiscount.evaluate !== "function") {
      return { discount_minor: 0, applied: [] };
    }
    try {
      var evalLines = [];
      for (var i = 0; i < lines.length; i += 1) {
        var l = lines[i];
        evalLines.push({
          sku:              l.sku,
          quantity:         l.qty,
          unit_price_minor: l.unit_amount_minor,
        });
      }
      var res = await autoDiscount.evaluate({
        cart: {
          subtotal_minor: subtotalMinor,
          lines:          evalLines,
        },
        customer_id: customerId || undefined,
        // Shopper-presented coupon codes unlock code-gated rules. Absent /
        // empty leaves only the pure-automatic rules in play, so a quote
        // with no codes is byte-identical to the pre-code behaviour.
        codes: Array.isArray(codes) && codes.length ? codes : undefined,
      });
      var appliedRaw = res && Array.isArray(res.applied) ? res.applied : [];
      var total   = 0;
      var applied = [];
      for (var j = 0; j < appliedRaw.length; j += 1) {
        var entry = appliedRaw[j];
        // A `free_shipping` rule's savings are a shipping reduction,
        // not a subtotal discount — excluded so the subtotal-level
        // `discount_minor` stays a pure subtotal reduction (the
        // shipping primitive owns the shipping side).
        if (!entry || entry.value_kind === "free_shipping") continue;
        var s = entry.savings_minor;
        if (!Number.isInteger(s) || s <= 0) continue;
        total += s;
        applied.push({ rule_slug: entry.rule_slug, savings_minor: s });
      }
      if (!Number.isFinite(total) || total <= 0) {
        return { discount_minor: 0, applied: [] };
      }
      // Clamp to the subtotal floor: the discount can reduce the
      // subtotal to zero but never past it.
      if (total > subtotalMinor) total = subtotalMinor;
      return { discount_minor: total, applied: applied };
    } catch (_e) {
      // Any engine failure -> no discount, never a 5xx on the buy path.
      return { discount_minor: 0, applied: [] };
    }
  }

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

  // Record each applied auto-discount rule against a committed order
  // so the engine's redemption counter + event log reflect the use.
  // Best-effort / drop-silent: the customer has already been charged
  // (or the order is otherwise placed) by the time this runs, so a
  // recording failure must NEVER fail or reverse the order. Each
  // record is isolated in its own try/catch so one bad row can't stop
  // the rest. No-op when the engine isn't wired or nothing applied.
  async function _recordAutoDiscounts(quote, orderId, customerId) {
    if (!autoDiscount || typeof autoDiscount.recordApplication !== "function") return;
    var applied = quote && Array.isArray(quote.auto_discounts) ? quote.auto_discounts : [];
    for (var i = 0; i < applied.length; i += 1) {
      var a = applied[i];
      if (!a || !a.rule_slug) continue;
      try {
        await autoDiscount.recordApplication({
          rule_slug:     a.rule_slug,
          order_id:      orderId,
          savings_minor: a.savings_minor,
          customer_id:   customerId || undefined,
        });
      } catch (_e) {
        // drop-silent — by design: the order is already placed; a
        // failed redemption record must not surface to the buyer.
      }
    }
  }

  // Record HOW a cart-level order discount split across the order lines,
  // for accounting + partial-refund precision. The recorded breakdown's
  // per-line `allocated_minor` values sum exactly to the discount, so a
  // later partial refund of one line can remove that line's share rather
  // than the whole-order amount.
  //
  // POST-COMMIT + drop-silent — by design: the order is already placed
  // (and, in the charged path, the PaymentIntent already exists) by the
  // time this runs. The entire body is wrapped in one try/catch so a
  // recording failure (bad input, DB error, an unmigrated table) can
  // NEVER fail, reverse, or change the charge of a placed order. This is
  // pure back-office bookkeeping with zero impact on the charged amount.
  //
  // No-op when: the recorder isn't wired, the order carried no discount
  // (discount_minor <= 0), or the order has no lines to split across.
  // The default split is `proportional` (by line subtotal) — the
  // operator-readable "each line absorbs its share of the savings"
  // distribution.
  async function _recordDiscountAllocation(quote, orderLines, orderId) {
    if (!discountAllocation ||
        typeof discountAllocation.allocate !== "function" ||
        typeof discountAllocation.recordAllocation !== "function") return;
    try {
      var discount = quote && quote.totals ? quote.totals.discount_minor : 0;
      if (!Number.isInteger(discount) || discount <= 0) return;   // no discount -> record nothing
      if (!Array.isArray(orderLines) || orderLines.length === 0) return;

      // Build the allocate() line shape from the placed order lines. The
      // line_id is the PERSISTED order-line id, so a later partial refund —
      // which operates on order lines — can apply the breakdown directly
      // without re-mapping by (variant, sku). The per-line subtotal is
      // unit_amount_minor * qty — the same per-line
      // figure pricing.subtotal summed into quote.totals.subtotal_minor,
      // so the discount (clamped to <= subtotal upstream) never exceeds
      // the total line weight.
      var lines = [];
      for (var i = 0; i < orderLines.length; i += 1) {
        var l = orderLines[i];
        var lineId = l.line_id != null ? l.line_id : l.id;
        if (lineId == null) return;                                 // no stable id to key the breakdown on
        lines.push({
          line_id:        String(lineId),
          subtotal_minor: l.unit_amount_minor * l.qty,
          quantity:       l.qty,
        });
      }

      var breakdown = discountAllocation.allocate({
        lines:          lines,
        discount_minor: discount,
        kind:           "proportional",
      });
      await discountAllocation.recordAllocation({
        order_id:        orderId,
        discount_source: "auto_discount",
        kind:            "proportional",
        breakdown:       breakdown,
        total_minor:     discount,
      });
    } catch (_e) {
      // drop-silent — by design: the order is already placed; a failed
      // allocation record is back-office bookkeeping and must never
      // surface to the buyer or affect the charge.
    }
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
    var rawLines = await cart.listLines(c.id);
    if (rawLines.length === 0)    throw new TypeError("checkout: cart is empty");
    // Reapply the active quantity-break for each line at confirm time —
    // the order total + the per-line price written onto the order
    // reflect the break, not the bare add-time snapshot. Pass-through
    // when the engine isn't wired.
    var lines = await _repriceLines(c, rawLines);

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
        // All-digital cart: shipping.rates() deliberately filters the
        // physical services out, so the caller's default (a physical
        // service id like "std") can never resolve — that is the cart's
        // shape, not a config error. Prefer the operator's digital_only
        // offering when one is configured; otherwise synthesize the
        // zero-cost no-shipping selection so a digital-only order
        // completes. A physical cart with an unresolvable id still
        // throws — that IS a config typo and must surface.
        var anyShippable = enrichedLines.some(function (l) {
          return l.requires_shipping === undefined ? true : !!l.requires_shipping;
        });
        if (!anyShippable) {
          selected = ratesRow.services.length
            ? ratesRow.services[0]
            : { id: "digital_none", label: "No shipping required", amount_minor: 0, digital_only: true };
        } else {
          throw new TypeError("checkout: selected_shipping_id " + JSON.stringify(input.selected_shipping_id) +
                              " not available for ship_to");
        }
      }
    }

    var shippingMinor = selected ? selected.amount_minor : 0;

    // Automatic discounts: consult the operator-authored rule engine
    // (when wired) for the subtotal reduction this cart earns. The
    // resolver clamps the result to [0, subtotal] and falls back to 0
    // on any failure, so the total math below is identical to the
    // un-wired flow whenever no rule applies.
    var autoDisc = await _resolveAutoDiscount(lines, sub.amount_minor, c.customer_id || null, input.codes);

    var totals = pricing.totals(c, lines, {
      tax_minor:      taxRow.tax_minor,
      shipping_minor: shippingMinor,
      discount_minor: autoDisc.discount_minor,
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
      // Per-rule breakdown that fed `totals.discount_minor`, replayed
      // by confirm()'s post-commit recorder. Empty when no rule
      // applied (or no engine wired).
      auto_discounts:    autoDisc.applied,
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
      // guardEmail.sanitize is a content-safety gate (CRLF smuggling,
      // homoglyphs, multi-@) — it passes a plain non-address string
      // through unchanged, so the shape gate lives here: a single @, a
      // dotted domain, the RFC 5321 length cap. Customer-facing message —
      // the checkout form echoes it on the field.
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
        throw new TypeError("checkout: customer.email — Enter a valid email address.");
      }
      var custName = input.customer.name;
      if (custName != null && (typeof custName !== "string" || custName.length > 120)) {
        throw new TypeError("checkout: customer.name — Enter a name of 120 characters or fewer.");
      }
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
        // Best-effort: record the auto-discount redemptions against the
        // placed order. Runs post-commit so a recording failure can't
        // reverse an order that's already paid.
        await _recordAutoDiscounts(quote, paidOrder.id, cartRow.customer_id || null);
        // Best-effort: record how the cart-level discount split across the
        // order lines (accounting + refund precision). Post-commit +
        // drop-silent — no impact on the already-settled order.
        await _recordDiscountAllocation(quote, paidOrder.lines, paidOrder.id);
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
      // Best-effort: record the auto-discount redemptions against the
      // placed order. Runs post-commit so a recording failure can't
      // reverse or fail an order whose PaymentIntent already exists.
      await _recordAutoDiscounts(quote, createdOrder.id, cartRow.customer_id || null);
      // Best-effort: record how the cart-level discount split across the
      // order lines (accounting + refund precision). Post-commit +
      // drop-silent — the PaymentIntent already exists; this never
      // changes the charged amount.
      await _recordDiscountAllocation(quote, createdOrder.lines, createdOrder.id);

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
