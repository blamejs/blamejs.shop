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
// Shared decimal↔minor conversion (zero-decimal-currency aware) — the
// PAYMENT.CAPTURE.REFUNDED mirror parses the webhook's decimal amount with
// the same table the adapter encodes outbound amounts from.
var paymentLib = require("./payment");

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
  // Optional backorder + preorder handles. When wired, a line whose SKU
  // is actively backorderable (`backorder.availabilityFor` →
  // `backorderable`) or has an open pre-order campaign
  // (`preorder.openCampaignForSku` → a row) is EXEMPT from the
  // confirm-time stock hold: those flows deliberately sell beyond the
  // shelf (the operator commits to ship later / the unit isn't released
  // yet). Absent — no SKU is exempted on these grounds, which matches
  // production today (neither primitive is mounted on the buy path);
  // a SKU with no inventory row is still treated as unlimited regardless.
  var backorder = deps.backorder || null;
  var preorder  = deps.preorder  || null;

  // Optional inbound-webhook replay defense. A validly-signed Stripe event
  // can be replayed verbatim inside the ±5-minute signature tolerance: the
  // signature still verifies, so signature-checking alone does not stop a
  // replay, and the downstream order-state idempotency is keyed on order
  // state (not event identity) so a refund/cancel replay or a replay that
  // races the first delivery slips past it. When `webhookReplayQuery` (a
  // D1 query fn) is wired, every verified Stripe event id is atomically
  // recorded with an INSERT ... ON CONFLICT DO NOTHING; a replay loses the
  // PRIMARY-KEY race and is treated as an already-processed no-op. The
  // store composes b.nonceStore over a D1-backed atomic backend rather
  // than a hand-rolled has/set (which would race). Absent — the handler is
  // byte-identical to the un-wired flow (order-state idempotency still
  // covers the common re-delivery), so this is additive, never required.
  var webhookReplayQuery = (typeof deps.webhookReplayQuery === "function")
    ? deps.webhookReplayQuery : null;
  var STRIPE_REPLAY_TTL_MS = b.constants.TIME.minutes(5); // matches the signature tolerance window
  // PayPal claims live in the same store but keep a much longer window:
  // PayPal's verify-webhook-signature API has no timestamp tolerance of ours
  // to lean on, and PayPal redelivers an unacknowledged event for ~3 days
  // (up to ~25 attempts) — a claim that expired before the last legitimate
  // redelivery would let a captured payload re-apply. Claimed ids are
  // namespaced ("paypal:<event-id>") so the two providers can never collide
  // in the shared table.
  var PAYPAL_REPLAY_TTL_MS = b.constants.TIME.days(3);
  var _stripeReplayStore = null;
  function _stripeReplay() {
    if (!webhookReplayQuery) return null;
    if (!_stripeReplayStore) {
      // Custom b.nonceStore backend: the atomicity lives in the D1
      // INSERT ... ON CONFLICT DO NOTHING (the PRIMARY KEY race decides
      // first-seen vs replay), so the check + insert can never interleave.
      _stripeReplayStore = b.nonceStore.create({
        backend: {
          checkAndInsert: async function (eventId, expireAt) {
            var nowMs = Date.now();
            var r = await webhookReplayQuery(
              "INSERT INTO stripe_webhook_events (event_id, first_seen_at, expires_at) " +
              "VALUES (?1, ?2, ?3) ON CONFLICT (event_id) DO NOTHING",
              [eventId, nowMs, expireAt],
            );
            // rowCount/changes === 1 → first sighting (recorded); 0 → replay.
            var changes = (r && r.meta && typeof r.meta.changes === "number") ? r.meta.changes
              : (r && typeof r.rowCount === "number") ? r.rowCount
              : (r && typeof r.changes === "number") ? r.changes : 0;
            return changes > 0;
          },
          purgeExpired: async function () {
            var r = await webhookReplayQuery(
              "DELETE FROM stripe_webhook_events WHERE expires_at < ?1",
              [Date.now()],
            );
            if (r && r.meta && typeof r.meta.changes === "number") return r.meta.changes;
            if (r && typeof r.rowCount === "number") return r.rowCount;
            if (r && typeof r.changes === "number") return r.changes;
            return 0;
          },
        },
      });
    }
    return _stripeReplayStore;
  }

  // Has a provider refund with this id already been mirrored into the
  // order's ledger? Scans the hydrated transition rows for a `refund` row
  // whose metadata carries the same provider refund id. This is what makes
  // the webhook refund mirror idempotent across BOTH paths a refund reaches
  // us twice: the admin console issues the refund (stamping the provider
  // refund id on its ledger row) and the provider then mirrors the same
  // refund back as a webhook; or the provider redelivers the same event
  // under a fresh delivery attempt after the replay claim's TTL.
  function _refundAlreadyRecorded(o, metaKey, refundId) {
    if (!refundId) return false;
    var rows = (o && o.transitions) || [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].on_event !== "refund") continue;
      var meta;
      try { meta = JSON.parse(rows[i].metadata_json || "{}"); }
      catch (_e) { meta = {}; }
      if (meta && meta[metaKey] === refundId) return true;
    }
    return false;
  }

  // Mirror a PayPal PAYMENT.CAPTURE.REFUNDED event into the order ledger,
  // AMOUNT-AWARE. The resource is the refund object itself: its `amount` is
  // that single refund's value (NOT a cumulative figure), so a $5 dashboard
  // refund on a $50 order must append a $5 partial-refund row — never drive
  // the terminal refund edge, which re-credits every gift-card/loyalty
  // credit on the order. Only a slice that clears the remaining balance is
  // terminal. A missing/garbled/currency-mismatched amount THROWS a coded
  // error the webhook route maps to a 5xx so PayPal redelivers — guessing
  // "full refund" here is customer-influenceable value creation.
  async function _mirrorPaypalRefund(o, event, ppOrderId) {
    var eventType = event.event_type;
    var resource  = event.resource || {};
    var refundId  = (typeof resource.id === "string" && resource.id.length) ? resource.id : null;
    if (o.status === "refunded") {
      return { handled: true, event_type: eventType, order: o, skipped: "already-advanced" };
    }
    if (_refundAlreadyRecorded(o, "paypal_refund_id", refundId)) {
      return { handled: true, event_type: eventType, order: o, skipped: "already-recorded", paypal_refund_id: refundId };
    }
    var amount = resource.amount || {};
    var amountMinor;
    try {
      var ccy = typeof amount.currency_code === "string" ? amount.currency_code.toUpperCase() : "";
      if (ccy !== String(o.currency || "").toUpperCase()) {
        throw new TypeError("refund currency " + JSON.stringify(amount.currency_code) +
                            " does not match order currency " + JSON.stringify(o.currency));
      }
      amountMinor = paymentLib._decimalToMinor(amount.value, ccy);
    } catch (e) {
      var bad = new Error("checkout: PAYMENT.CAPTURE.REFUNDED resource.amount is missing or unparseable — " +
                          ((e && e.message) || String(e)));
      bad.code = "PAYPAL_REFUND_AMOUNT_INVALID";
      throw bad;
    }
    if (amountMinor <= 0) {
      var zero = new Error("checkout: PAYMENT.CAPTURE.REFUNDED resource.amount must be positive");
      zero.code = "PAYPAL_REFUND_AMOUNT_INVALID";
      throw zero;
    }
    var refundedSoFar = await order.refundedTotalMinor(o.id);
    var grand     = Number(o.grand_total_minor) || 0;
    var remaining = grand - refundedSoFar;
    if (remaining <= 0) {
      return { handled: true, event_type: eventType, order: o, skipped: "nothing-remaining" };
    }
    var meta = { paypal_event_id: event.id, paypal_order_id: ppOrderId, paypal_refund_id: refundId };
    if (amountMinor >= remaining) {
      // Balance-clearing — drive the terminal refund edge (full credit
      // reversal). The stamped amount is CAPPED at the remaining balance so
      // refundedTotalMinor converges exactly on the grand total.
      var updated = await order.transition(o.id, "refund", {
        reason:   "paypal:" + eventType,
        metadata: Object.assign({}, meta, { amount_minor: remaining }),
      });
      return { handled: true, event_type: eventType, order: updated, amount_minor: remaining };
    }
    // Partial — append the same-state ledger row; recordPartialRefund runs
    // the proportional gift-card / loyalty reversal against the cumulative
    // refunded total.
    var updatedPartial = await order.recordPartialRefund(o.id, {
      amount_minor: amountMinor,
      reason:       "paypal:" + eventType,
      metadata:     meta,
    });
    return { handled: true, event_type: eventType, order: updatedPartial, partial: true, amount_minor: amountMinor };
  }

  // Mirror a Stripe charge.refunded event into the order ledger,
  // AMOUNT-AWARE — same discipline as the PayPal mirror above, adapted to
  // Stripe's shape: charge.refunded fires on EVERY refund (partial
  // included); `amount_refunded` is the CUMULATIVE minor-unit total refunded
  // on the charge and `refunded` is true only when the charge is fully
  // refunded. The mirrored slice is the DELTA between Stripe's cumulative
  // figure and the local ledger, which makes the mirror naturally
  // idempotent against the console's own refunds (the console records
  // first; the event's delta is then zero). A missing/garbled
  // amount_refunded throws (5xx → Stripe redelivers) — never guess full.
  async function _mirrorStripeRefund(o, event) {
    var eventType = event.type;
    if (o.status === "refunded") {
      return { handled: true, event_type: eventType, order: o, skipped: "already-advanced" };
    }
    var charge = (event.data && event.data.object) || {};
    var cumulative = charge.amount_refunded;
    if (!Number.isInteger(cumulative) || cumulative < 0) {
      var bad = new Error("checkout: charge.refunded carries no integer amount_refunded — refusing to guess a refund amount");
      bad.code = "STRIPE_REFUND_AMOUNT_INVALID";
      throw bad;
    }
    var refundedSoFar = await order.refundedTotalMinor(o.id);
    var grand     = Number(o.grand_total_minor) || 0;
    var remaining = grand - refundedSoFar;
    var delta     = cumulative - refundedSoFar;
    var meta = { stripe_event_id: event.id };
    if (charge.refunded === true || cumulative >= grand) {
      // Charge fully refunded — terminal edge. (On a split-tender order the
      // charge covers only the provider-paid share; a full charge refund
      // still voids the order, and the terminal edge re-credits the
      // gift-card / loyalty share — same semantics the admin full-refund
      // console applies.) Stamp the capped remaining balance so the ledger
      // converges on the grand total.
      var updated = await order.transition(o.id, "refund", {
        reason:   "stripe:" + eventType,
        metadata: remaining > 0 ? Object.assign({}, meta, { amount_minor: remaining }) : meta,
      });
      return { handled: true, event_type: eventType, order: updated };
    }
    if (delta <= 0) {
      // Ledger already at (or past) Stripe's cumulative figure — the
      // console mirrored this refund when it issued it.
      return { handled: true, event_type: eventType, order: o, skipped: "already-recorded" };
    }
    var updatedPartial = await order.recordPartialRefund(o.id, {
      amount_minor: delta,
      reason:       "stripe:" + eventType,
      metadata:     meta,
    });
    return { handled: true, event_type: eventType, order: updatedPartial, partial: true, amount_minor: delta };
  }

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
    // A zero balance applies nothing — treat it as no credit rather than
    // attempting a zero-amount debit (an anomalous active card at 0 would
    // otherwise turn into a validation throw deep in the redeem).
    if (applied <= 0) return null;
    // `code_plain` is the bearer code the redeem decrement re-hashes;
    // it lives only in this in-memory resolution, never persisted.
    return { card: card, code_plain: code, applied_minor: applied, balance_minor: card.balance_minor };
  }

  // Debit the resolved gift-card credit — the authoritative double-spend
  // gate. Runs BEFORE the order (and any PaymentIntent / PayPal order)
  // exists: two checkouts presenting the same card race the
  // `balance_minor >= ?` SQL predicate HERE, while nothing has been
  // charged or created, so the loser's coded GIFTCARD_INSUFFICIENT_BALANCE
  // propagates into a clean rollback (holds + claim released) and a
  // re-quote — never a second paid order against an already-spent card.
  // The redemption row is written with a NULL order id and attached to the
  // order by _settleGiftCardPostCreate once the order row exists; a
  // checkout that dies between debit and order creation reverses the debit
  // via giftcards.reverseRedemptionById in the rollback path.
  async function _debitGiftCard(resolved) {
    return giftcards.redeem({
      code:         resolved.code_plain,
      order_id:     null,
      amount_minor: resolved.applied_minor,
    });
  }

  // Attach a pre-charge gift-card debit to the order it paid for and write
  // the operator-facing ledger audit row. The order link is what the
  // refund/cancel reversers key on (reverseRedemption /
  // reverseRedemptionProRata select by order_id), so a link failure is
  // surfaced LOUDLY to the audit sink for reconciliation — but neither the
  // link nor the ledger row may throw out of the post-create path: the
  // order and its live charge already exist, the card debit already
  // landed, and both writes are reconcilable from the redemption record.
  async function _settleGiftCardPostCreate(resolved, redemption, orderId) {
    try {
      var linked = await giftcards.linkRedemptionToOrder(redemption.redemption_id, orderId);
      if (!linked) throw new Error("redemption " + redemption.redemption_id + " did not accept the order link");
    } catch (linkErr) {
      try {
        b.audit.safeEmit({
          action:   "checkout.giftcard.order_link.error",
          outcome:  "failure",
          metadata: {
            gift_card_id:  resolved.card.id,
            redemption_id: redemption.redemption_id,
            order_id:      orderId,
            message:       (linkErr && linkErr.message) || String(linkErr),
          },
        });
      } catch (_auditErr) { /* drop-silent — the redemption record is the durable trail */ }
    }
    if (giftCardLedger) {
      try {
        await giftCardLedger.debit({
          gift_card_id: resolved.card.id,
          order_id:     orderId,
          amount_minor: resolved.applied_minor,
        });
      } catch (ledgerErr) {
        // Surface for reconciliation, but never let the audit-row write undo
        // a card debit that already landed or strand the placed order.
        try {
          b.audit.safeEmit({
            action:   "checkout.giftcard.ledger_debit.error",
            outcome:  "failure",
            metadata: {
              gift_card_id: resolved.card.id,
              order_id:     orderId,
              amount_minor: resolved.applied_minor,
              message:      (ledgerErr && ledgerErr.message) || String(ledgerErr),
            },
          });
        } catch (_auditErr) { /* drop-silent — the redemption record is the durable trail */ }
      }
    }
  }

  // Reverse the pre-charge credit debits when a checkout dies BEFORE its
  // order exists (PaymentIntent refused, PayPal open failed, order insert
  // threw). The card/points were taken for an order that will now never
  // be created, so the rollback paths call this before releasing holds and
  // the cart claim. Both reversals are claim-guarded (exactly-once) and
  // keyed on the debit row itself — no order id was ever attached. A
  // reversal failure is audited, never thrown: the original checkout error
  // is the actionable one, and the unreversed debit is reconcilable from
  // the audit trail.
  async function _reverseCreditDebits(rollbackCtx) {
    if (!rollbackCtx) return;
    if (rollbackCtx.giftCardDebit) {
      try {
        await giftcards.reverseRedemptionById(rollbackCtx.giftCardDebit.redemption.redemption_id);
      } catch (revErr) {
        try {
          b.audit.safeEmit({
            action:   "checkout.giftcard.rollback_reverse.error",
            outcome:  "failure",
            metadata: {
              redemption_id: rollbackCtx.giftCardDebit.redemption.redemption_id,
              amount_minor:  rollbackCtx.giftCardDebit.resolved.applied_minor,
              message:       (revErr && revErr.message) || String(revErr),
            },
          });
        } catch (_auditErr) { /* drop-silent — the original checkout error is the actionable one */ }
      }
    }
    if (rollbackCtx.loyaltyDebit) {
      try {
        await loyalty.reverseRedemptionById(rollbackCtx.loyaltyDebit.redemption.tx_id);
      } catch (revErr) {
        try {
          b.audit.safeEmit({
            action:   "checkout.loyalty.rollback_reverse.error",
            outcome:  "failure",
            metadata: {
              tx_id:   rollbackCtx.loyaltyDebit.redemption.tx_id,
              message: (revErr && revErr.message) || String(revErr),
            },
          });
        } catch (_auditErr) { /* drop-silent — the original checkout error is the actionable one */ }
      }
    }
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

  // Debit the resolved loyalty credit — same pre-charge discipline as the
  // gift-card debit: the `balance_points >= ?` predicate in loyalty.redeem
  // is the cross-cart double-spend gate, so it must land before any money
  // moves. The burn's ledger row is written with a NULL order id and
  // attached by _settleLoyaltyPostCreate once the order exists; a checkout
  // that dies in between reverses via loyalty.reverseRedemptionById in the
  // rollback path.
  async function _debitLoyalty(resolved, customerId) {
    return loyalty.redeem({
      customer_id: customerId,
      points:      resolved.points,
      order_id:    null,
      notes:       "checkout-credit",
    });
  }

  // Attach a pre-charge loyalty burn to the order it tendered for. The
  // order link is what restoreRedemption keys on for refund restores, so a
  // link failure is audited loudly — but never thrown: the order and its
  // live charge already exist and the burn is reconcilable from the
  // ledger row.
  async function _settleLoyaltyPostCreate(redemption, orderId) {
    try {
      var linked = await loyalty.linkRedemptionToOrder(redemption.tx_id, orderId);
      if (!linked) throw new Error("loyalty tx " + redemption.tx_id + " did not accept the order link");
    } catch (linkErr) {
      try {
        b.audit.safeEmit({
          action:   "checkout.loyalty.order_link.error",
          outcome:  "failure",
          metadata: {
            tx_id:    redemption.tx_id,
            order_id: orderId,
            message:  (linkErr && linkErr.message) || String(linkErr),
          },
        });
      } catch (_auditErr) { /* drop-silent — the burn row is the durable trail */ }
    }
  }

  // Reserve each applied auto-discount rule's redemption BEFORE any money
  // moves — a capped rule is a finite resource, so checkout claims it
  // pre-charge under the same reserve-then-settle discipline inventory
  // holds follow. A refused claim (cap exhausted, or lost to a concurrent
  // order — the bypass that let a single-use code apply to every racing
  // checkout) FAILS CLOSED with a coded error: the buyer re-quotes and
  // sees the true price, never a silently-different charge. Claims are
  // stashed on the rollback holder so a later pre-order throw releases
  // them; claim-ref reuse makes a same-checkout retry idempotent.
  async function _claimAutoDiscounts(quote, customerId, claimRef, rollbackHolder) {
    if (!autoDiscount || typeof autoDiscount.claimRedemption !== "function") return;
    var applied = quote && Array.isArray(quote.auto_discounts) ? quote.auto_discounts : [];
    for (var i = 0; i < applied.length; i += 1) {
      var a = applied[i];
      if (!a || !a.rule_slug) continue;
      var claim = await autoDiscount.claimRedemption({
        rule_slug:     a.rule_slug,
        claim_ref:     claimRef,
        savings_minor: a.savings_minor,
        customer_id:   customerId || undefined,
      });
      if (!claim.claimed) {
        var gone = new Error("checkout: the " + JSON.stringify(a.rule_slug) +
                             " discount is no longer available (" + claim.reason + ")");
        gone.code = "AUTO_DISCOUNT_EXHAUSTED";
        throw gone;
      }
      if (rollbackHolder) {
        if (!rollbackHolder.autoDiscountClaims) rollbackHolder.autoDiscountClaims = [];
        rollbackHolder.autoDiscountClaims.push({ rule_slug: a.rule_slug, claim_ref: claimRef });
      }
    }
  }

  // Re-key the pre-charge claims to the order that now exists, so the
  // redemption rows the metrics/admin surfaces read carry the real order
  // id. POST-COMMIT best-effort with a loud audit — the order and its
  // charge already exist; the claim row itself (and the cap it reserved)
  // landed pre-charge and is correct regardless.
  async function _linkAutoDiscounts(quote, claimRef, orderId) {
    if (!autoDiscount || typeof autoDiscount.linkClaimToOrder !== "function") return;
    var applied = quote && Array.isArray(quote.auto_discounts) ? quote.auto_discounts : [];
    for (var i = 0; i < applied.length; i += 1) {
      var a = applied[i];
      if (!a || !a.rule_slug) continue;
      try {
        await autoDiscount.linkClaimToOrder({
          rule_slug: a.rule_slug,
          claim_ref: claimRef,
          order_id:  orderId,
        });
      } catch (linkErr) {
        try {
          b.audit.safeEmit({
            action:   "checkout.autodiscount.order_link.error",
            outcome:  "failure",
            metadata: { rule_slug: a.rule_slug, order_id: orderId, message: (linkErr && linkErr.message) || String(linkErr) },
          });
        } catch (_auditErr) { /* drop-silent — the claim row is the durable trail */ }
      }
    }
  }

  // Release pre-charge discount claims when the checkout dies before its
  // order exists — the reservation goes back to the cap. Audited, never
  // thrown: the original checkout error is the actionable one.
  async function _releaseAutoDiscountClaims(rollbackHolder) {
    if (!rollbackHolder || !rollbackHolder.autoDiscountClaims) return;
    if (!autoDiscount || typeof autoDiscount.releaseClaim !== "function") return;
    for (var i = 0; i < rollbackHolder.autoDiscountClaims.length; i += 1) {
      var cl = rollbackHolder.autoDiscountClaims[i];
      try {
        await autoDiscount.releaseClaim({ rule_slug: cl.rule_slug, claim_ref: cl.claim_ref });
      } catch (relErr) {
        try {
          b.audit.safeEmit({
            action:   "checkout.autodiscount.claim_release.error",
            outcome:  "failure",
            metadata: { rule_slug: cl.rule_slug, claim_ref: cl.claim_ref, message: (relErr && relErr.message) || String(relErr) },
          });
        } catch (_auditErr) { /* drop-silent — the original checkout error is the actionable one */ }
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

  // Is this SKU exempt from the confirm-time stock hold? Pre-order and
  // backorder lines deliberately sell beyond the shelf, so they pass
  // through without a hold. Both lookups are optional (the handles may
  // be unwired) and defensive — any read failure falls back to "not
  // exempt" so a flaky lookup tightens (never loosens) enforcement.
  async function _holdExempt(sku) {
    if (preorder && typeof preorder.openCampaignForSku === "function") {
      try {
        var campaign = await preorder.openCampaignForSku(sku);
        // A pre-order line sells beyond the shelf only while the campaign
        // is genuinely pre-launch: before `launch_at` the unit isn't
        // released yet, so the hold is deliberately skipped. ONCE
        // `launch_at` has passed, the SKU is selling against real stock —
        // keep it hold-exempt and a past-launch campaign that the operator
        // never manually flipped to `launched` would oversell real
        // inventory without bound. So past-launch_at → NOT exempt (holds
        // apply). openCampaignForSku's own semantics are unchanged (the
        // storefront PDP CTA still keys off the active row); the launch_at
        // gate lives here, on the buy path. A campaign with no launch_at
        // is treated as still-pre-launch (exempt).
        if (campaign) {
          var launchAt = campaign.launch_at == null ? null : Number(campaign.launch_at);
          if (launchAt == null || !Number.isFinite(launchAt) || launchAt > Date.now()) {
            return true;
          }
        }
      } catch (_e) { /* not exempt on lookup failure */ }
    }
    if (backorder && typeof backorder.availabilityFor === "function") {
      try {
        var a = await backorder.availabilityFor(sku);
        if (a && a.status === "backorderable") return true;
      } catch (_e) { /* not exempt on lookup failure */ }
    }
    return false;
  }

  // Reserve stock for every shippable, non-exempt line BEFORE any charge.
  // Each hold is an atomic conditional UPDATE (`catalog.inventory.hold`):
  // the SKU's available stock (on_hand − held) must cover the line qty or
  // the write matches zero rows. On the FIRST insufficient line we release
  // every hold already placed in this pass and throw a coded
  // INSUFFICIENT_STOCK error carrying a friendly, per-line message — the
  // storefront re-renders the checkout form inline with that message, the
  // same recoverable UX a rejected gift-card / loyalty code gets. Nothing
  // is charged and no order row is created, so a refused checkout leaves
  // zero side effects beyond the already-rolled-back holds.
  //
  // Digital lines (requires_shipping false) never debit stock. An
  // un-tracked SKU (no inventory row) is unlimited (hold → null) and
  // passes through. Each line that DID hold is annotated with `_held_qty`
  // so the order line records the exact reserved quantity (the paid
  // decrement + cancel release act on it). Returns the list of placed
  // { sku, qty } holds so the caller can release them if a LATER step
  // (gift-card burn, order create) throws before the order is committed.
  async function _placeStockHolds(quoteLines) {
    var placed = [];
    for (var i = 0; i < quoteLines.length; i += 1) {
      var l = quoteLines[i];
      l._held_qty = 0;                                 // default: held nothing
      if (!l.requires_shipping) continue;             // digital — no shelf
      if (await _holdExempt(l.sku)) continue;          // preorder / backorder
      var res = await catalog.inventory.hold(l.sku, l.qty);
      if (res == null) continue;                       // un-tracked SKU — unlimited
      if (res.held) { l._held_qty = l.qty; placed.push({ sku: l.sku, qty: l.qty }); continue; }
      // Insufficient stock for this line — roll back the pass and refuse.
      await _releaseStockHolds(placed);
      var title = l.title || l.sku;
      var refused = new Error("checkout: " + title + " — only a limited quantity is in stock. " +
        "Lower the quantity or remove it to continue.");
      refused.code = "INSUFFICIENT_STOCK";
      refused.sku  = l.sku;
      throw refused;
    }
    return placed;
  }

  // Best-effort release of a set of placed holds (the rollback path).
  // Drop-silent per hold: a release failure must not mask the original
  // error that triggered the rollback. This path runs ONLY when no pending
  // order was created (the conditional rollback in confirm) — once an order
  // exists it owns its holds, and the only thing that frees them is the
  // paid decrement, an explicit cancel, or the stale-pending-order reaper
  // (`reapStalePending`), driven once a minute by the worker cron, which
  // cancels pending orders older than the TTL so their holds release.
  async function _releaseStockHolds(holds) {
    if (!Array.isArray(holds)) return;
    for (var i = 0; i < holds.length; i += 1) {
      try { await catalog.inventory.release(holds[i].sku, holds[i].qty); }
      catch (_e) { /* drop-silent — rollback best-effort */ }
    }
  }

  // Compose a quote from a cart + ship-to + (optional) selected
  // shipping service. Pure read — no DB writes.
  async function _buildQuote(input, qOpts) {
    if (!input || typeof input !== "object") throw new TypeError("checkout.quote: input required");
    _uuid(input.cart_id, "cart_id");
    _shipTo(input.ship_to);
    qOpts = qOpts || {};

    var c = await cart.get(input.cart_id);
    if (!c)                       throw new TypeError("checkout: cart " + input.cart_id + " not found");
    // A live preview (quote) requires the cart to be active. confirm() claims
    // the cart to 'converted' BEFORE building the quote (the single-charge
    // gate against a double-submit), so on that path the claimed status is
    // permitted via qOpts.allowClaimed — the cart confirm is settling IS
    // 'converted', and rejecting it here would break the very flow that owns
    // the conversion.
    if (c.status !== "active" && !(qOpts.allowClaimed && c.status === "converted")) {
      throw new TypeError("checkout: cart status is " + c.status + ", cannot quote");
    }
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

      // Atomic single-charge gate against a double-submit. Two concurrent
      // POST /checkout requests for the same cart (a double-click, two tabs,
      // a retried form post) must NOT each create a PaymentIntent + order.
      // claimForCheckout flips the cart 'active' → 'converted' in one atomic
      // UPDATE; exactly one racer matches the row and proceeds, the other
      // loses the claim and is told the checkout is already in progress —
      // never a second charge. A non-active cart (already converting /
      // converted / abandoned) loses for the same reason. The claim runs
      // BEFORE the PaymentIntent so the loser can't slip a charge in.
      var claim = await cart.claimForCheckout(input.cart_id);
      if (!claim.cart) throw new TypeError("checkout: cart " + input.cart_id + " not found");
      if (!claim.claimed) {
        // Lost the claim — another checkout for this cart is in flight or
        // already completed. Surface a typed signal so the storefront can
        // redirect to the in-progress order rather than starting a second.
        var inProgress = new Error("checkout: a checkout is already in progress for this cart");
        inProgress.code = "CHECKOUT_IN_PROGRESS";
        throw inProgress;
      }

      // The cart is claimed ('converted'); from here a throw BEFORE the order
      // is created must RELEASE the claim ('converted' → 'active') so the
      // shopper can retry. Once the order exists the claim is permanent (the
      // order owns the conversion) — the reaper / cancel edge handles an
      // abandoned pending order, not a re-openable cart. rollbackCtx, shared
      // with _confirmAfterHolds, flips orderCreated true the instant the order
      // row exists so neither the stock-hold release nor the claim release
      // fires once the order owns them.
      var rollbackCtx = { orderCreated: false };
      try {
        // Deterministic Stripe idempotency key, derived from the claimed
        // cart. One cart = one checkout (the claim guarantees it), so even if
        // a double-fire reached the provider, Stripe collapses both onto the
        // same PaymentIntent (same key → same intent). The caller-supplied
        // idempotency_key is ignored for the provider call — the cart claim
        // is the authoritative single-charge identity — but still accepted on
        // the input for backward compatibility / the record-only paths.
        var idempotencyKey = "checkout:" + input.cart_id;

        var quote = await _buildQuote(input, { allowClaimed: true });
        if (!quote.selected_shipping) {
          // _buildQuote already threw above, but defense in depth.
          throw new TypeError("checkout.confirm: selected_shipping resolution returned null");
        }
        if (quote.totals.grand_total_minor <= 0) {
          throw new TypeError("checkout.confirm: grand_total_minor must be > 0 (zero-total orders use a separate freebie flow)");
        }

        // Reserve stock for every shippable, non-exempt line BEFORE any
        // charge. Insufficient stock throws a coded INSUFFICIENT_STOCK error
        // here (no PaymentIntent, no order) which the storefront re-renders
        // inline. The holds placed here ride into the pending order and are
        // converted to a real shelf debit on the paid transition (or released
        // when the order is cancelled / expires).
        var stockHolds = await _placeStockHolds(quote.lines);
        // Stash the placed holds on rollbackCtx so the single catch below can
        // release them when a later step throws before the order is created.
        rollbackCtx.stockHolds = stockHolds;
        return await this._confirmAfterHolds(input, quote, email, stockHolds, rollbackCtx, idempotencyKey);
      } catch (e) {
        // Only roll back when no pending order was created. Once
        // createFromCart succeeds the order OWNS the holds + the conversion —
        // releasing the holds would double-free (the paid decrement / cancel
        // release, or the stale-pending reaper, settles them) and could eat a
        // concurrent shopper's hold on the same SKU, and re-opening the cart
        // would orphan the order. A throw before the order exists releases
        // both the placed holds AND the checkout claim so the shopper can
        // retry on the same cart. Both releases are atomic + self-targeting,
        // so neither can disturb a genuinely completed checkout.
        if (!rollbackCtx.orderCreated) {
          // Reverse any pre-charge credit debits and discount claims first
          // — the card/points/caps were taken for an order that will now
          // never exist (both helpers are claim-guarded, audited, and
          // never throw).
          await _reverseCreditDebits(rollbackCtx);
          await _releaseAutoDiscountClaims(rollbackCtx);
          if (rollbackCtx.stockHolds) {
            try { await _releaseStockHolds(rollbackCtx.stockHolds); }
            catch (_holdErr) { /* drop-silent — claim release below + original error are the actionable parts */ }
          }
          try { await cart.releaseCheckoutClaim(input.cart_id); }
          catch (_releaseErr) { /* drop-silent — the original error below is the actionable one */ }
        }
        throw e;
      }
    },

    // The body of confirm() once stock is held. Split out so the holds
    // placed in confirm() release on any throw from here down via the
    // single try/catch above — the two return paths (fully-credited and
    // Stripe-intent) both live inside that guard. Internal — invoked only
    // through confirm() above (hence the `_` prefix); `stockHolds` is the
    // list of placed holds, which both terminal paths leave in place (the
    // pending order owns them until paid / cancelled). `rollbackCtx` is the
    // mutable flag the catch reads: set `orderCreated` true the moment a
    // pending order exists so a LATER throw doesn't release holds the order
    // now owns.
    _confirmAfterHolds: async function (input, quote, email, stockHolds, rollbackCtx, idempotencyKey) {
      // The Stripe idempotency key is derived deterministically from the
      // claimed cart by confirm() (one cart = one checkout), so a double-fire
      // collapses onto a single PaymentIntent on Stripe's side. Defended for
      // a direct call: fall back to the input key.
      if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
        idempotencyKey = (typeof input.idempotency_key === "string" && input.idempotency_key.length >= 8)
          ? input.idempotency_key
          : ("checkout:" + input.cart_id);
      }
      // Resolve an optional gift-card credit BEFORE any charge so a bad
      // code fails the checkout without touching Stripe. The credit
      // reduces the amount due; the order still records the full grand
      // total it owed.
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

      // Reserve the applied auto-discount redemptions FIRST (cheapest
      // claim, fails closed on an exhausted cap with a clean re-quote),
      // then the credit debits — all inside the rollback-protected region.
      await _claimAutoDiscounts(quote, loyaltyCustomerId, idempotencyKey, rollbackCtx);

      // Authoritative credit debits — PRE-charge, inside the rollback-
      // protected region (rollbackCtx.orderCreated is still false). The SQL
      // balance gates in giftcards.redeem / loyalty.redeem are the
      // CROSS-CART double-spend guard: two checkouts presenting the same
      // card (or the same points balance) race those predicates here,
      // before any PaymentIntent or order exists, and the loser's coded
      // error propagates into confirm()'s clean rollback (holds + claim
      // released) for a re-quote. The debited rows carry no order id yet —
      // they are linked post-create, or reversed by the rollback when a
      // later step throws before the order exists.
      var gcRedemption = null;
      if (gc) {
        gcRedemption = await _debitGiftCard(gc);
        if (rollbackCtx) rollbackCtx.giftCardDebit = { resolved: gc, redemption: gcRedemption };
      }
      var loyRedemption = null;
      if (loy) {
        loyRedemption = await _debitLoyalty(loy, loyaltyCustomerId);
        if (rollbackCtx) rollbackCtx.loyaltyDebit = { redemption: loyRedemption };
      }

      var orderLines = quote.lines.map(function (l) {
        return {
          variant_id:        l.variant_id,
          sku:               l.sku,
          qty:               l.qty,
          unit_amount_minor: l.unit_amount_minor,
          unit_currency:     l.unit_currency,
          // Units this line reserved at confirm (0 unless a hold landed) so
          // the order's paid/cancel transitions settle the exact hold.
          stock_held_qty:    l._held_qty || 0,
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
          payment_provider:  null,   // credits covered the whole total — no provider charge to refund
          ship_to:           input.ship_to,
          customer_email_hash: emailHash,
          lines:             orderLines,
        });
        // The pending order now owns the holds — a throw from here on must
        // NOT blanket-release them (see the conditional rollback in confirm).
        if (rollbackCtx) rollbackCtx.orderCreated = true;
        // The credits were already debited pre-charge above (the debit IS
        // the double-spend gate); what remains is attaching the debit rows
        // to the order that now exists + the ledger audit row. Both are
        // best-effort with loud audits — a failure here must not strand
        // the cart un-converted.
        if (gc) await _settleGiftCardPostCreate(gc, gcRedemption, paidOrder.id);
        if (loy) await _settleLoyaltyPostCreate(loyRedemption, paidOrder.id);
        // Re-key the pre-charge discount claims to the placed order. Runs
        // post-commit so a link failure can't reverse an order that's
        // already paid (the cap reservation itself landed pre-charge).
        await _linkAutoDiscounts(quote, idempotencyKey, paidOrder.id);
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
        payment_provider:  "stripe",   // refund surfaces route the refund dial by this
        ship_to:           input.ship_to,
        customer_email_hash: emailHash,
        lines:             orderLines,
      });
      // The pending order now owns the holds — a throw from here on (gift-card
      // burn, discount recording) must NOT blanket-release them (see the
      // conditional rollback in confirm). The reaper / cancel / paid edge
      // settles them now that the order exists.
      if (rollbackCtx) rollbackCtx.orderCreated = true;

      // Attach the pre-charge credit debits to the created order. The
      // authoritative card/points debits already landed BEFORE the
      // PaymentIntent was opened (the debit is the double-spend gate); the
      // remaining writes — the order link the refund reversers key on, and
      // the gift-card ledger audit row — are POST-COMMIT best-effort with
      // loud audits, because the order + its live PaymentIntent now exist
      // and a throw from here would leave the cart un-converted with an
      // orphaned charge (the conditional rollback above no longer fires —
      // orderCreated is set).
      if (gc) await _settleGiftCardPostCreate(gc, gcRedemption, createdOrder.id);
      if (loy) await _settleLoyaltyPostCreate(loyRedemption, createdOrder.id);
      // Re-key the pre-charge discount claims to the placed order. Runs
      // post-commit so a link failure can't reverse or fail an order whose
      // PaymentIntent already exists (the cap reservation landed pre-charge).
      await _linkAutoDiscounts(quote, idempotencyKey, createdOrder.id);
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

    // Stale-pending-order reaper. A pending order whose buyer abandoned the
    // payment sheet (Stripe / PayPal) or whose PaymentIntent expired holds
    // its reserved stock forever — `confirm` places the holds and creates
    // the pending order, but the only hold-freeing FSM edges are
    // pending→paid (decrement) and pending→cancelled (release), and nothing
    // fires the cancel automatically. This reaper, driven once a minute by
    // the worker cron's `/_/stale-order-reap` tick, cancels orders older
    // than the TTL so their holds release.
    //
    // Per order, Stripe-paid orders: cancel the PaymentIntent FIRST so a
    // late authorization can't complete AFTER we cancel the order. If Stripe
    // reports the PI already succeeded / is not cancelable
    // (`payment_intent_unexpected_state`, or any non-success cancel), SKIP
    // the order — the webhook has settled or will settle it, and cancelling
    // an order whose payment may have completed would lose a real sale.
    // Only after a clean PI cancel (or for an order with no Stripe
    // PaymentIntent — a PayPal-created order, whose capture path guards on
    // local status so reaping first is safe, or a zero-amount leftover) do
    // we fire the cancel transition, which releases the holds via the
    // existing path.
    //
    // Per-order failures are drop-silent + continue (hot-path sink tier) but
    // COUNTED in the returned summary so the operator sees the reap's shape.
    // `ttlMinutes` is validated config-time by the caller (the tick handler
    // throws on garbage at boot); defended here too with a documented
    // default so a direct call is never unsafe.
    reapStalePending: async function (opts) {
      opts = opts || {};
      var ttlMinutes = opts.ttl_minutes;
      if (ttlMinutes == null) ttlMinutes = 120;
      if (typeof ttlMinutes !== "number" || !isFinite(ttlMinutes) || !Number.isInteger(ttlMinutes) || ttlMinutes < 5) {
        throw new TypeError("checkout.reapStalePending: ttl_minutes must be an integer >= 5");
      }
      var nowMs    = typeof opts.now === "number" ? opts.now : Date.now();
      var cutoffTs = nowMs - b.constants.TIME.minutes(ttlMinutes);
      var batchLimit = opts.limit == null ? 100 : opts.limit;

      var summary = {
        scanned:        0,
        reaped:         0,   // cancelled (holds released)
        skipped_paid:   0,   // PI already succeeded / not cancelable — left pending
        errored:        0,   // a per-order failure, dropped + counted
      };

      var stale;
      try {
        stale = (await order.listStalePending(cutoffTs, batchLimit)).rows;
      } catch (e) {
        // The candidate read itself failed — surface it in the summary
        // rather than throwing out of the tick (which would 5xx the cron).
        return Object.assign({ ok: false, error: (e && e.message) || String(e) }, summary);
      }
      summary.scanned = stale.length;

      for (var i = 0; i < stale.length; i += 1) {
        var row = stale[i];
        try {
          var piId = row.payment_intent_id;
          // A Stripe PaymentIntent id is `pi_…`; a PayPal order id is opaque
          // (no `pi_` prefix) and has no cancel API for an unapproved order
          // (its capture path guards on local status, so reaping first can
          // never double-charge). Only the Stripe case needs a pre-cancel.
          var isStripePi = typeof piId === "string" && piId.indexOf("pi_") === 0;
          if (isStripePi && payment && typeof payment.cancelPaymentIntent === "function") {
            try {
              await payment.cancelPaymentIntent(piId);
            } catch (_cancelErr) {
              // PI already succeeded / not cancelable → the webhook owns this
              // order's settlement. Leave it pending; never cancel an order
              // whose payment may have completed.
              summary.skipped_paid += 1;
              continue;
            }
          }
          // PI cancelled cleanly (or no Stripe PI) — release the holds by
          // cancelling the order through the existing FSM edge.
          await order.transition(row.id, "cancel", { reason: "stale-pending-reap" });
          summary.reaped += 1;
        } catch (_e) {
          // drop-silent per order — by design (hot-path sink): one bad order
          // must not poison the sweep. Counted so the operator sees it.
          summary.errored += 1;
        }
      }
      return Object.assign({ ok: true }, summary);
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

      // Replay defense — atomically claim this event id the moment the
      // signature verifies, BEFORE any subscription routing or state
      // transition. A replayed (already-seen) event id loses the
      // PRIMARY-KEY race and short-circuits to a processed no-op so no
      // transition, refund-mirror, or subscription update runs twice. A
      // store error fails CLOSED inside the nonceStore (returns
      // not-fresh) — a replay is indistinguishable from a wiped store, so
      // refusing is the safe default. No-op when the store isn't wired.
      var replay = _stripeReplay();
      if (replay && event && typeof event.id === "string" && event.id.length > 0) {
        var fresh = await replay.checkAndInsert(event.id, Date.now() + STRIPE_REPLAY_TTL_MS);
        if (!fresh) {
          return { handled: true, event_type: eventType || null, skipped: "replay", event_id: event.id };
        }
      }

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

      // Refund events are AMOUNT-AWARE — a partial dashboard refund must
      // append a partial ledger row, never drive the terminal refund edge
      // (which re-credits every gift-card/loyalty credit on the order).
      if (eventType === "charge.refunded") {
        return await _mirrorStripeRefund(o, event);
      }

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
      // Reserve stock before opening the PayPal order — same atomic holds
      // the Stripe confirm places, so the two payment paths can't oversell
      // against each other. Insufficient stock throws INSUFFICIENT_STOCK
      // here (no PayPal order created). Released on any throw before the
      // local order row commits.
      var ppHolds = await _placeStockHolds(quote.lines);
      // Conditional rollback, identical discipline to the Stripe confirm:
      // release the placed holds ONLY when no pending order was created.
      // Once createFromCart succeeds the order owns the holds; releasing
      // them here would double-free and could eat a concurrent shopper's
      // hold on the same SKU. A pending PayPal order that the buyer never
      // approves is reaped by the stale-pending reaper (no PayPal-side
      // cancel needed — the capture path guards on local status).
      var ppOrderCreated = false;
      var ppRollback = {};
      try {
      // Resolve an optional gift-card credit before opening the PayPal
      // order so a bad code fails without a remote round-trip.
      var gc = await _resolveGiftCard(input.gift_card_code, quote);
      var cartRow = await cart.get(quote.cart_id);
      // Loyalty points credit stacks on top of any gift-card credit — same
      // resolution + residual re-cap discipline as the Stripe confirm path
      // (_confirmAfterHolds), so the two payment buttons honor identical
      // credits. Requires a signed-in customer; the resolver refuses a
      // points request on a guest cart with a clean coded error.
      var ppLoyaltyCustomerId = cartRow ? (cartRow.customer_id || null) : null;
      var loy = await _resolveLoyaltyCredit(input.loyalty_redeem_points, ppLoyaltyCustomerId, quote);
      var afterGiftCard = quote.totals.grand_total_minor - (gc ? gc.applied_minor : 0);
      if (loy && loy.applied_minor > afterGiftCard) {
        loy.applied_minor = afterGiftCard < 0 ? 0 : afterGiftCard;
        var ppPerUsd = loyalty.REDEMPTION_POINTS_PER_USD;
        loy.points = Math.ceil((loy.applied_minor * ppPerUsd) / 100);
        if (loy.applied_minor <= 0) loy = null;
      }
      var amountDue = afterGiftCard - (loy ? loy.applied_minor : 0);

      // Reserve the applied auto-discount redemptions, then the credit
      // debits — PRE-charge, same cross-cart double-spend discipline as
      // the Stripe confirm (see _confirmAfterHolds): the SQL gates race
      // here, before the PayPal order or the local order exist, and the
      // loser's coded error rolls this checkout back cleanly. Linked
      // post-create; reversed by the catch below when a later step throws
      // before the order exists.
      await _claimAutoDiscounts(quote, ppLoyaltyCustomerId, idempotencyKey, ppRollback);
      var gcRedemption = null;
      if (gc) {
        gcRedemption = await _debitGiftCard(gc);
        ppRollback.giftCardDebit = { resolved: gc, redemption: gcRedemption };
      }
      var loyRedemption = null;
      if (loy) {
        loyRedemption = await _debitLoyalty(loy, ppLoyaltyCustomerId);
        ppRollback.loyaltyDebit = { redemption: loyRedemption };
      }

      var emailHash = customers ? customers.hashEmail(email) : null;
      var ppLines = quote.lines.map(function (l) {
        return { variant_id: l.variant_id, sku: l.sku, qty: l.qty, unit_amount_minor: l.unit_amount_minor, unit_currency: l.unit_currency, stock_held_qty: l._held_qty || 0 };
      });

      // Credits fully cover the order — no PayPal order (PayPal refuses a
      // zero-amount order). Create + burn + mark paid, same as the Stripe
      // full-coverage path. No provider charge → payment_provider stays
      // null (there is nothing a provider could refund).
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
          payment_provider:    null,
          ship_to:             input.ship_to,
          customer_email_hash: emailHash,
          lines:               ppLines,
        });
        ppOrderCreated = true;
        // Same settlement posture as the Stripe branches: the authoritative
        // debits + claims landed pre-charge; attach them to the order that
        // now exists (best-effort, loudly audited — never stranding).
        if (gc) await _settleGiftCardPostCreate(gc, gcRedemption, paidOrder.id);
        if (loy) await _settleLoyaltyPostCreate(loyRedemption, paidOrder.id);
        await _linkAutoDiscounts(quote, idempotencyKey, paidOrder.id);
        await cart.setStatus(quote.cart_id, "converted");
        var settled = await order.transition(paidOrder.id, "mark_paid", {
          reason: loy && !gc ? "loyalty:full" : "gift_card:full",
        });
        return {
          order: settled, paypal_order_id: null, status: "PAID_BY_GIFT_CARD",
          gift_card: gc ? { applied_minor: gc.applied_minor, amount_due_minor: 0 } : null,
          loyalty:   loy ? { points: loy.points, applied_minor: loy.applied_minor, amount_due_minor: 0 } : null,
        };
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
        payment_provider:    "paypal",     // refund surfaces route the refund dial by this
        ship_to:             input.ship_to,
        customer_email_hash: emailHash,
        lines:               ppLines,
      });
      ppOrderCreated = true;
      // Attach the pre-charge debits + claims to the created order — the
      // authoritative card/points debits and cap reservations landed before
      // the PayPal order was opened; the order links + ledger row are
      // post-commit best-effort with loud audits (a throw here would leave
      // the cart active with an orphaned PayPal order).
      if (gc) await _settleGiftCardPostCreate(gc, gcRedemption, createdOrder.id);
      if (loy) await _settleLoyaltyPostCreate(loyRedemption, createdOrder.id);
      await _linkAutoDiscounts(quote, idempotencyKey, createdOrder.id);
      await cart.setStatus(quote.cart_id, "converted");
      return {
        order: createdOrder, paypal_order_id: ppOrder.id, status: ppOrder.status,
        gift_card: gc ? { applied_minor: gc.applied_minor, amount_due_minor: amountDue } : null,
        loyalty:   loy ? { points: loy.points, applied_minor: loy.applied_minor, amount_due_minor: amountDue } : null,
      };
      } catch (e) {
        // A throw BEFORE the order row commits (PayPal open failure,
        // gift-card error) reverses any pre-charge credit debits and
        // discount claims and releases the holds so PayPal can't strand
        // stock, burn credit, or leak a cap reservation. After the order
        // commits it owns the holds — don't blanket-release.
        if (!ppOrderCreated) {
          await _reverseCreditDebits(ppRollback);
          await _releaseAutoDiscountClaims(ppRollback);
          await _releaseStockHolds(ppHolds);
        }
        throw e;
      }
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
        // Persist the capture id on the order row — refunds dial
        // /v2/payments/captures/<capture-id>/refund, NOT the PayPal order id
        // stored in payment_intent_id. Best-effort (drop-silent — by
        // design): the metadata stamp on the transition below remains the
        // recoverable source, and a persistence refusal must never block
        // settling a real payment.
        if (captureId) {
          try { await order.setPaypalCapture(o.id, captureId); }
          catch (_e2) { /* drop-silent — recoverable from the transition metadata */ }
        }
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

      // Replay defense — atomically claim this verified event id BEFORE any
      // transition or ledger write, same ordering as the Stripe handler.
      // Load-bearing for the refund mirror below: recordPartialRefund is an
      // append (not state-idempotent), so a re-delivered partial REFUNDED
      // event that raced past state checks would otherwise double-append.
      // A store error fails CLOSED inside the nonceStore (not-fresh), so a
      // wiped/unreachable store refuses rather than re-applies. No-op when
      // the store isn't wired (the refund-id dedupe in the mirror still
      // covers sequential re-delivery).
      var replay = _stripeReplay();
      if (replay && typeof event.id === "string" && event.id.length > 0) {
        var fresh = await replay.checkAndInsert("paypal:" + event.id, Date.now() + PAYPAL_REPLAY_TTL_MS);
        if (!fresh) {
          return { handled: true, event_type: eventType, skipped: "replay", event_id: event.id };
        }
      }

      var fsmEvent = PAYPAL_EVENT_MAP[eventType];
      if (!fsmEvent) return { handled: false, event_type: eventType, reason: "no-state-change" };
      // The PayPal order id lives in the capture resource's related ids.
      var ppOrderId = null;
      try { ppOrderId = event.resource.supplementary_data.related_ids.order_id; } catch (_e) { ppOrderId = null; }
      if (!ppOrderId) return { handled: false, event_type: eventType, reason: "no-order-id" };
      var o = await order.byPaymentIntent(ppOrderId);
      if (!o) return { handled: false, event_type: eventType, reason: "order-not-found" };

      // Refund events are AMOUNT-AWARE — see _mirrorPaypalRefund: a partial
      // dashboard refund appends a partial ledger row; only a
      // balance-clearing slice drives the terminal refund edge.
      if (eventType === "PAYMENT.CAPTURE.REFUNDED") {
        return await _mirrorPaypalRefund(o, event, ppOrderId);
      }

      if (fsmEvent === "mark_paid" && o.status !== "pending") {
        return { handled: true, event_type: eventType, order: o, skipped: "already-advanced" };
      }
      // The COMPLETED resource is the capture itself — persist its id so
      // refunds can run against the capture without re-dialing PayPal. The
      // write is best-effort here (the metadata stamp below remains the
      // recoverable source): a refused write must never block settling a
      // real payment.
      var ppCaptureId = (eventType === "PAYMENT.CAPTURE.COMPLETED" && event.resource &&
                         typeof event.resource.id === "string" && event.resource.id.length)
        ? event.resource.id : null;
      if (ppCaptureId) {
        try { await order.setPaypalCapture(o.id, ppCaptureId); }
        catch (_e) { /* drop-silent — by design: capture-id persistence must not block mark_paid; the transition metadata keeps it recoverable */ }
      }
      var updated = await order.transition(o.id, fsmEvent, {
        reason:   "paypal:" + eventType,
        metadata: ppCaptureId
          ? { paypal_event_id: event.id, paypal_order_id: ppOrderId, paypal_capture_id: ppCaptureId }
          : { paypal_event_id: event.id, paypal_order_id: ppOrderId },
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
