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

var b = require("./vendor/blamejs");

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

// Pickup (BOPIS) edges. An in-store collection has no carrier ship leg:
// the goods sit on the hold shelf and the customer walks in. So a pickup
// order goes straight from `paid` (or `fulfilling`, if the picker started
// staging) to `delivered` on a single `mark_picked_up` event — driving it
// through mark_shipped would record a carrier handoff that never happened.
// These edges are kept OUT of ORDER_TRANSITIONS (and therefore out of
// transitionsFrom) so the operator order-detail page doesn't sprout a
// "mark picked up" button on every paid order — the click-and-collect
// primitive fires the event when the front-counter operator captures the
// pickup. They ARE merged into the FSM definition below so the transition
// is legal: previously markPickedUp tried `mark_delivered` from `paid`,
// which the FSM refused (delivered is only reachable from shipped) and the
// caller swallowed — leaving the pickup schedule `picked_up` while the
// parent order stayed stuck at paid/fulfilling.
var PICKUP_TRANSITIONS = Object.freeze([
  { from: "paid",       to: "delivered",  on: "mark_picked_up" },
  { from: "fulfilling", to: "delivered",  on: "mark_picked_up" },
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
    transitions: ORDER_TRANSITIONS.concat(PICKUP_TRANSITIONS).map(function (t) {
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

// The proof routes a guest-order reconciliation can be attributed to.
// "verified-email" = an OIDC sign-in whose provider verified the address;
// "magic-link" = the buyer clicked a sign-in link emailed to the address.
// Both prove control of the email — the trust anchor for the attach. An
// unknown linked_via falls back to "verified-email" so a typo can't write
// an unfiltered audit string.
var RECONCILE_LINKED_VIA = Object.freeze(["verified-email", "magic-link"]);

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

// Read the per-SKU stock-hold map an order recorded at creation time. It
// lives in the `__init__` transition's metadata (`{ stock_holds: { sku:
// qty } }`), written by createFromCart when the checkout reserved shelf
// units. Returns `{}` for an order that held nothing (digital-only, an
// inventory-less deploy, or an order created before this was wired) so the
// settlement loop is a clean no-op. Defensive against a missing /
// malformed metadata blob — a parse failure yields no holds rather than a
// throw that would break a legitimate state transition.
function _stockHoldMap(order) {
  if (!order || !Array.isArray(order.transitions)) return {};
  var init = null;
  for (var i = 0; i < order.transitions.length; i += 1) {
    if (order.transitions[i].from_state === "__init__") { init = order.transitions[i]; break; }
  }
  if (!init || !init.metadata_json) return {};
  var parsed;
  try { parsed = JSON.parse(init.metadata_json); }
  catch (_e) { return {}; }
  if (!parsed || typeof parsed.stock_holds !== "object" || !parsed.stock_holds) return {};
  var out = {};
  var skus = Object.keys(parsed.stock_holds);
  for (var s = 0; s < skus.length; s += 1) {
    var q = Number(parsed.stock_holds[skus[s]]);
    if (Number.isInteger(q) && q > 0) out[skus[s]] = q;
  }
  return out;
}

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
  // Optional loyalty earn dispatcher — when present, an order reaching
  // `paid` fans out to the customer's loyalty balance via the earn
  // rules (per_dollar_spent / per_purchase / first_purchase). Opt-in
  // like `webhooks` so callers and the test suite can run without
  // standing up a loyalty primitive. The award runs fire-and-forget on
  // the same detached-promise discipline as the webhook fan-out: the
  // transition has already persisted, so a loyalty read/write must not
  // add latency to (or fail) the order transition.
  var loyaltyEarnRules = opts.loyaltyEarnRules || null;
  // Optional referrals dispatcher — when present, an order reaching
  // `paid` records the buyer's first qualifying purchase against any
  // referral invitation pinned to their account, which completes the
  // referrer's funnel (bumps referrals_count → the leaderboard). Opt-in
  // like `webhooks` / `loyaltyEarnRules` so callers and the test suite
  // run without standing up a referrals primitive. `trackPurchase` is
  // idempotent (first_purchase_at is set only once) and a no-op when the
  // buyer was never referred, so a re-delivered mark_paid can't double-
  // reward and an organic purchase is silently skipped. The award runs
  // fire-and-forget on the same detached-promise discipline as the
  // loyalty fan-out: the transition has already persisted.
  var referrals = opts.referrals || null;
  // Optional new-order observer — a `function (order)` the FSM calls,
  // fire-and-forget, the moment an order reaches `paid` (pending →
  // paid). It's how the operator console learns a sale settled without
  // polling: the application points the slot at an adapter that drops
  // an operator-inbox entry (and a navbar badge ticks up). Late-bound
  // via `setNewOrderObserver` because the operator-ping adapter is
  // constructed AFTER the order primitive (it composes the same order
  // handle to read the customer/total), so the slot is assigned once
  // the wiring is complete. Opt-in like the other fan-outs; absent it
  // the paid edge is a clean no-op. The call is detached on the same
  // discipline as the loyalty / referral fan-outs — the transition has
  // already persisted, so an observer read/write must never add latency
  // to (or fail) the order transition.
  var newOrderObserver = (typeof opts.newOrderObserver === "function")
    ? opts.newOrderObserver
    : null;
  // Optional inventory handle — when present, the order FSM converts the
  // confirm-time stock holds into real shelf movements as the order
  // changes state. On `mark_paid` (pending → paid) each shippable line's
  // held units are debited from on_hand via `inventory.decrement`; on
  // `cancel` FROM PENDING (pending → cancelled — a never-paid order that
  // timed out or the buyer abandoned) each line's hold is released via
  // `inventory.release`. Both run SYNCHRONOUSLY inside the transition,
  // before the fire-and-forget fan-outs, because stock truth is not
  // best-effort: a paid order MUST debit the shelf and a cancelled
  // pending order MUST free its hold. Both verbs are idempotent and
  // self-targeting — `decrement` matches only lines that still hold the
  // qty (so a re-delivered mark_paid is a no-op and an exempt / un-tracked
  // line is skipped), and `release` only clears an active hold. Refund
  // (paid → refunded) and cancel-after-paid (paid → cancelled) DO NOT
  // touch inventory: a returned item is not automatically back on the
  // shelf — the operator restocks via the admin inventory console once
  // the physical return is inspected. Opt-in like the other handles so
  // tests and an inventory-less deploy run unchanged.
  var inventory = opts.inventory || null;
  // Optional error-log handle — when present, an inventory settlement
  // failure (a decrement / release throw on the paid / cancel edge) is
  // captured to the operator's error feed (/admin/errors) with the exact
  // sku / qty / order so the stranded hold is reconcilable by hand via the
  // inventory-adjustment surface. Opt-in like the other handles; absent it,
  // settlement failures still surface to the audit sink (b.audit.safeEmit
  // below), just not the durable error feed.
  var errorLog = opts.errorLog || null;
  // Optional gift-card handle — when present, the order FSM credits a
  // gift-card spend back when the order dies without completing. A checkout
  // that partially covers payment with a gift card debits the card's balance
  // at confirm; if the order is then cancelled (the stale-pending reaper, an
  // explicit cancel) or refunded (a payment-failed / refund webhook), that
  // debit must return to the card or the customer's balance is silently
  // burned. This mirrors the inventory-hold release: it's transition-driven
  // on the same cancel / refund edges, runs synchronously before the
  // fire-and-forget fan-outs, and is idempotent (reverseRedemption claims
  // each redemption with an unreversed predicate) so a re-delivered webhook
  // can't double-credit. Opt-in like the other handles; absent it, an
  // unwired deploy (or a test with no gift cards) runs unchanged.
  var giftCards = opts.giftCards || null;
  if (giftCards && typeof giftCards.reverseRedemption !== "function") {
    throw new TypeError("order.create: opts.giftCards must expose a reverseRedemption(order_id) method");
  }
  // Optional gift-card ledger handle — when present alongside giftCards, a
  // reversal also writes a refund_to_giftcard credit so the append-only
  // ledger history records the money returning to the card (the card row's
  // balance is authoritative; the ledger is the audit trail surfaced in the
  // admin console).
  var giftCardLedger = opts.giftCardLedger || null;
  // Optional loyalty handle — when present, the FSM restores loyalty points
  // a customer SPENT as a checkout tender when the order is refunded /
  // cancelled, symmetric with the gift-card-spend restore above. The points
  // were debited at checkout via loyalty.redeem against this order; a refund
  // returns the buyer's money, so the points they tendered have to come back
  // to their balance or the refund silently burns them (inconsistent with the
  // gift-card spend, which IS restored). Distinct from `loyaltyEarnRules`
  // (which reverses points EARNED on the purchase) — this restores points
  // SPENT on it. Restore is proportional to the refunded amount + idempotent
  // (restoreRedemption tracks cumulative restored per redeem row). Opt-in;
  // absent it, a deploy without loyalty-as-tender runs unchanged.
  var loyalty = opts.loyalty || null;
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

  // Settle one held SKU on a state edge — `inventory.decrement` on the
  // paid edge, `inventory.release` on the cancel-from-pending edge.
  //
  // drop-silent-with-capture — by design: the order's payment has already
  // succeeded (paid edge) or the cancel has already persisted (cancel
  // edge), and the webhook driving this MUST return 2xx or Stripe retries
  // forever. A throw here would 500 the webhook, the retry would hit the
  // already-advanced guard and skip, and the hold would strand silently.
  // So a per-SKU settlement failure is caught, NOT re-thrown, and surfaced
  // LOUDLY instead: an `order.settlement.error` audit event plus, when the
  // error-log handle is wired, a durable row in /admin/errors carrying the
  // exact sku / qty / order so the operator reconciles the stranded hold
  // via the inventory-adjustment surface. Returns true on success, false on
  // a (captured) failure so the caller can count strandings.
  async function _settleSku(verb, sku, qty, orderId) {
    try {
      await inventory[verb](sku, qty);
      return true;
    } catch (e) {
      var message = "order.settlement." + verb + " failed — sku=" + sku +
        " qty=" + qty + " order=" + orderId + ": " + (e && e.message || e);
      try {
        b.audit.safeEmit({
          action:   "order.settlement.error",
          outcome:  "failure",
          metadata: { verb: verb, sku: sku, qty: qty, order_id: orderId, message: (e && e.message) || String(e) },
        });
      } catch (_auditErr) { /* drop-silent — the capture below is the durable record */ }
      if (errorLog && typeof errorLog.captureServerError === "function") {
        try {
          await errorLog.captureServerError({
            route:   "/order/" + orderId + "/settlement",
            method:  "POST",
            status:  500,
            message: message,
          });
        } catch (_logErr) { /* drop-silent — never let the error-feed write mask the original failure */ }
      }
      return false;
    }
  }

  // Credit back any gift-card spend on an order that died without
  // completing — the cancel / refund edge releasing the customer's money,
  // mirroring how _settleSku releases an inventory hold. reverseRedemption
  // is idempotent (each redemption claimed with an unreversed predicate), so
  // a re-delivered webhook or the reaper racing the cancel can't double-
  // credit. For each restored redemption a refund_to_giftcard ledger credit
  // is written when the ledger is wired so the audit trail records the money
  // returning.
  //
  // drop-silent-with-capture — same discipline as _settleSku: the cancel /
  // refund has already persisted and the webhook driving it MUST return 2xx,
  // so a reversal failure is caught, NOT re-thrown, and surfaced loudly (an
  // `order.giftcard.reversal.error` audit event plus, when the error-log
  // handle is wired, a durable /admin/errors row) for manual reconciliation.
  async function _settleGiftCards(orderId, refundedMinor, orderTotalMinor) {
    if (!giftCards) return;
    try {
      var reversed;
      if (typeof giftCards.reverseRedemptionProRata === "function"
          && Number.isInteger(orderTotalMinor) && orderTotalMinor > 0) {
        // Proportional reversal — re-mint only the share the refund covers.
        // reversed_minor tracks the cumulative already credited per
        // redemption, so a partial-then-final refund sequence converges
        // exactly on the original spend and never over-credits.
        reversed = await giftCards.reverseRedemptionProRata(orderId, {
          refunded_minor:    refundedMinor,
          order_total_minor: orderTotalMinor,
        });
      } else {
        // Fallback — a giftCards handle without the pro-rata method, or a
        // zero-total order: all-or-nothing reversal of the full spend.
        reversed = await giftCards.reverseRedemption(orderId);
      }
      if (giftCardLedger && typeof giftCardLedger.credit === "function") {
        for (var i = 0; i < reversed.length; i += 1) {
          var rev = reversed[i];
          if (!rev || !(Number(rev.amount_minor) > 0)) continue;
          try {
            // allow:money-binding-currency-without-catalog-check — this is a REVERSAL credit of an existing redemption: it replays the exact amount already debited from an already-issued card (whose currency was ISO-4217-validated at giftcards.issue time). No currency is supplied or chosen here — the ledger credit carries no currency field; it inherits the card's. There is no new currency surface to catalog-check.
            await giftCardLedger.credit({
              gift_card_id: rev.gift_card_id,
              amount_minor: rev.amount_minor,
              source:       "refund_to_giftcard",
              source_ref:   orderId,
            });
          } catch (_ledgerErr) { /* drop-silent — the card-row balance restore above is authoritative; the ledger credit is the audit trail */ }
        }
      }
    } catch (e) {
      var message = "order.giftcard-reversal failed — order=" + orderId + ": " + (e && e.message || e);
      try {
        b.audit.safeEmit({
          action:   "order.giftcard.reversal.error",
          outcome:  "failure",
          metadata: { order_id: orderId, message: (e && e.message) || String(e) },
        });
      } catch (_auditErr) { /* drop-silent — the capture below is the durable record */ }
      if (errorLog && typeof errorLog.captureServerError === "function") {
        try {
          await errorLog.captureServerError({
            route:   "/order/" + orderId + "/giftcard-reversal",
            method:  "POST",
            status:  500,
            message: message,
          });
        } catch (_logErr) { /* drop-silent — never let the error-feed write mask the original failure */ }
      }
    }
  }

  // Recover the non-cash tender split (gift-card spend + redeemed loyalty,
  // minor units) stamped on the order's init transition at create time. Cash
  // captured = grand_total - gift - loyalty. Orders placed before the split
  // was recorded return zeroes, so the cash-first refund math treats them as
  // cash-only (a partial refund never re-credits a non-cash tender; the
  // terminal full-refund edge still returns everything).
  async function _orderTenderSplit(orderId) {
    var split = { gift: 0, loyalty: 0 };
    var row = (await query(
      "SELECT metadata_json FROM order_transitions " +
      "WHERE order_id = ?1 AND on_event = 'create' LIMIT 1",
      [orderId],
    )).rows[0];
    if (row && row.metadata_json) {
      try {
        var m = JSON.parse(row.metadata_json);
        if (m && Number.isInteger(m.gift_card_applied_minor) && m.gift_card_applied_minor > 0) {
          split.gift = m.gift_card_applied_minor;
        }
        if (m && Number.isInteger(m.loyalty_applied_minor) && m.loyalty_applied_minor > 0) {
          split.loyalty = m.loyalty_applied_minor;
        }
      } catch (_e) { /* malformed metadata → treat as cash-only (safe: never over-credits) */ }
    }
    return split;
  }

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
      // Non-cash tender split (gift-card spend + redeemed loyalty, minor
      // units). Stamped onto the init transition below so a later partial
      // refund is cash-first: cash captured = grand_total - these. Optional,
      // default 0 (a cash-only order).
      var giftAppliedMinor    = input.gift_card_applied_minor == null ? 0 : input.gift_card_applied_minor;
      var loyaltyAppliedMinor = input.loyalty_applied_minor == null ? 0 : input.loyalty_applied_minor;
      _nonNegInt(giftAppliedMinor,    "gift_card_applied_minor");
      _nonNegInt(loyaltyAppliedMinor, "loyalty_applied_minor");
      _shipTo(input.ship_to);
      // Which payment provider captured (or will capture) this order's
      // charge — refund surfaces route the refund dial by this column.
      // Optional: a fully-credited order (gift card / loyalty cover the
      // whole total) carries no provider charge and stays NULL.
      if (input.payment_provider != null &&
          input.payment_provider !== "stripe" && input.payment_provider !== "paypal") {
        throw new TypeError("order.createFromCart: payment_provider must be 'stripe', 'paypal', or null");
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
        "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
        "payment_intent_id, payment_provider, ship_to_json, customer_email_hash, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
        [
          id, input.cart_id, input.customer_id || null, input.session_id,
          input.currency, input.subtotal_minor, input.discount_minor,
          input.tax_minor, input.shipping_minor, input.grand_total_minor,
          input.payment_intent_id || null, input.payment_provider || null,
          JSON.stringify(input.ship_to),
          input.customer_email_hash || null, ts,
        ],
      );
      // Accumulate the per-SKU stock-hold map as we write the lines. The
      // checkout passes `stock_held_qty` on every line that reserved shelf
      // units at confirm; lines that held nothing (digital / preorder /
      // backorder / un-tracked SKU) contribute 0. The map is stamped onto
      // the init-transition metadata below so the paid-time decrement and
      // the cancel-time release settle exactly the units THIS order held —
      // no schema column needed, and a cancel can never release stock that
      // belongs to another shopper's hold on the same SKU.
      var heldBySku = {};
      for (var i = 0; i < input.lines.length; i += 1) {
        var l = input.lines[i];
        _positiveInt(l.qty, "lines[" + i + "].qty");
        _nonNegInt(l.unit_amount_minor, "lines[" + i + "].unit_amount_minor");
        var heldQty = l.stock_held_qty == null ? 0 : l.stock_held_qty;
        _nonNegInt(heldQty, "lines[" + i + "].stock_held_qty");
        if (heldQty > 0) heldBySku[l.sku] = (heldBySku[l.sku] || 0) + heldQty;
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
      // Initial transition row — from no-prior-state into pending. Its
      // metadata carries the stock-hold map (`{ stock_holds: { sku: qty } }`)
      // so the FSM can settle the holds without a dedicated column.
      var initMetaObj = {};
      if (Object.keys(heldBySku).length) initMetaObj.stock_holds = heldBySku;
      // The non-cash tender split rides the same init transition so the refund
      // path recovers the cash captured without re-deriving it from the credit
      // ledgers. Recorded only when non-zero to keep the metadata lean.
      if (giftAppliedMinor > 0)    initMetaObj.gift_card_applied_minor = giftAppliedMinor;
      if (loyaltyAppliedMinor > 0) initMetaObj.loyalty_applied_minor   = loyaltyAppliedMinor;
      var initMeta = JSON.stringify(initMetaObj);
      await query(
        "INSERT INTO order_transitions (id, order_id, from_state, to_state, on_event, reason, metadata_json, occurred_at) " +
        "VALUES (?1, ?2, '__init__', 'pending', 'create', ?3, ?5, ?4)",
        [b.uuid.v7(), id, input.reason || null, ts, initMeta],
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

    // Persist the PayPal CAPTURE id on the order (and stamp the provider) —
    // PayPal refunds run against the capture, not the order id stored in
    // payment_intent_id. Called by the capture flow and the
    // PAYMENT.CAPTURE.COMPLETED webhook backstop. Write-once: the first
    // capture id recorded wins; a different id for an already-captured order
    // is refused with a coded error (an order has exactly one capture in
    // this flow — a mismatch means crossed wires, never something to
    // overwrite silently). Re-recording the SAME id is an idempotent no-op.
    setPaypalCapture: async function (orderId, captureId) {
      _uuid(orderId, "order id");
      if (typeof captureId !== "string" || !captureId.length || captureId.length > 64 ||
          /[\u0000-\u001f\u007f]/.test(captureId)) {
        throw new TypeError("order.setPaypalCapture: captureId must be a non-empty string <= 64 chars without control bytes");
      }
      var upd = await query(
        "UPDATE orders SET paypal_capture_id = ?1, payment_provider = 'paypal' " +
        "WHERE id = ?2 AND (paypal_capture_id IS NULL OR paypal_capture_id = ?1)",
        [captureId, orderId],
      );
      if (Number(upd.rowCount || 0) > 0) return true;
      var row = (await query("SELECT id, paypal_capture_id FROM orders WHERE id = ?1", [orderId])).rows[0];
      if (!row) throw new TypeError("order.setPaypalCapture: order " + orderId + " not found");
      var err = new Error("order.setPaypalCapture: order " + orderId + " already carries capture " +
                          row.paypal_capture_id + " — refusing to overwrite with " + captureId);
      err.code = "PAYPAL_CAPTURE_MISMATCH";
      throw err;
    },

    // Resolve the PayPal capture id for an order: the persisted column when
    // present, else recovered from the order's transition metadata (the
    // capture flow stamps `paypal_capture_id` on the mark_paid transition —
    // the only place pre-existing orders recorded it) and healed back onto
    // the column so the scan runs at most once per order. Returns the
    // capture id string or null (a Stripe / uncaptured order). Callers with
    // a PayPal handle may fall back to a remote getOrder read when this
    // local resolution returns null.
    paypalCaptureId: async function (orderId) {
      _uuid(orderId, "order id");
      var row = (await query("SELECT paypal_capture_id FROM orders WHERE id = ?1", [orderId])).rows[0];
      if (!row) return null;
      if (row.paypal_capture_id) return row.paypal_capture_id;
      var transitions = (await query(
        "SELECT metadata_json FROM order_transitions WHERE order_id = ?1 ORDER BY occurred_at ASC",
        [orderId],
      )).rows;
      for (var i = 0; i < transitions.length; i += 1) {
        var meta;
        try { meta = JSON.parse(transitions[i].metadata_json || "{}"); }
        catch (_e) { meta = {}; }
        if (meta && typeof meta.paypal_capture_id === "string" && meta.paypal_capture_id.length) {
          await this.setPaypalCapture(orderId, meta.paypal_capture_id);
          return meta.paypal_capture_id;
        }
      }
      return null;
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
      // Conditional claim guard — the state write only lands if the row is
      // STILL in the snapshot state we validated the edge against. `transition`
      // is a read-then-write (SELECT at the top, FSM replay, then this UPDATE);
      // without the `AND status = ?` predicate a concurrent writer that moved
      // the order between our SELECT and UPDATE would be silently overwritten.
      // The live race: the stale-pending-order reaper firing cancel
      // (pending → cancelled, releasing the hold) at the same instant a payment
      // webhook fires mark_paid (pending → paid, decrementing the shelf). On D1
      // a single UPDATE is atomic, so binding the snapshot status serializes
      // them: exactly one edge wins, the loser matches zero rows and bails
      // before it can double-release / double-decrement the hold or resurrect a
      // terminal order. Mirrors setPaymentIntent's own `WHERE id = ? AND
      // status = 'pending'` claim guard elsewhere in this file.
      var upd = await query(
        "UPDATE orders SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4",
        [result.to, ts, orderId, current.status],
      );
      if (Number(upd.rowCount || 0) === 0) {
        // Lost the race: another writer already transitioned this order out of
        // `current.status`. Our edge was computed from a now-stale snapshot, so
        // we apply nothing — no order_transitions row, no inventory settlement
        // (the winning edge settled its own holds), no webhook / loyalty /
        // referral fan-out. Collapse to a no-op and return the order as the
        // winner left it, so the caller observes the authoritative state.
        return await this.get(orderId);
      }
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
      // Inventory settlement — SYNCHRONOUS, before the fire-and-forget
      // fan-outs below. Stock truth is not best-effort: a paid order debits
      // the shelf, a cancelled-while-pending order frees its hold. The
      // edge (result.from → result.to) is authoritative, so this runs once
      // per real state change — a re-delivered webhook is collapsed to a
      // no-op transition upstream (the FSM refuses a second mark_paid from
      // `paid`), and the underlying verbs are idempotent regardless. Only
      // the two edges that own a hold act; refund and cancel-after-paid are
      // deliberately inert (the operator restocks a physical return by hand).
      if (inventory) {
        var holdMap = _stockHoldMap(refreshed);
        var holdSkus = Object.keys(holdMap);
        if (holdSkus.length) {
          // Each SKU settles in its own try/catch (_settleSku) so a single
          // SKU's decrement / release throw on a transient DB error can't
          // strand the OTHER SKUs' holds or 500 the webhook — the remaining
          // SKUs in the loop still settle, and each failure surfaces loudly
          // (audit + error-feed) for manual reconciliation. The transition
          // has already persisted; settlement is post-commit best-effort
          // with a durable failure trail, never a hard gate.
          if (result.from === "pending" && result.to === "paid"
              && typeof inventory.decrement === "function") {
            // Convert each held SKU's reservation into a real shelf debit,
            // scoped to the exact units this order held. decrement's own
            // guard (stock_held >= qty) makes a re-delivered mark_paid a
            // no-op, so this is idempotent across webhook re-deliveries.
            for (var di = 0; di < holdSkus.length; di += 1) {
              await _settleSku("decrement", holdSkus[di], holdMap[holdSkus[di]], orderId);
            }
          } else if (result.from === "pending" && result.to === "cancelled"
              && typeof inventory.release === "function") {
            // Free the holds of a pending order that never paid (timed out,
            // payment_intent.canceled, or an explicit cancel), scoped to the
            // exact units this order held so a cancel can never release stock
            // another shopper holds on the same SKU. release floors at zero
            // so a double-cancel can't underflow stock_held.
            for (var ri = 0; ri < holdSkus.length; ri += 1) {
              await _settleSku("release", holdSkus[ri], holdMap[holdSkus[ri]], orderId);
            }
          }
        }
      }
      // Gift-card settlement — SYNCHRONOUS, alongside the inventory release.
      // An order that reaches a terminal state WITHOUT completing the sale
      // (cancelled — pending-abandon or post-paid; refunded — payment failed
      // or a refund issued) must return any gift-card spend to the card.
      // Unlike inventory (where a refund deliberately doesn't auto-restock a
      // physical good), the gift-card credit is the customer's own money, so
      // it's released on every death edge. reverseRedemption is idempotent,
      // so a re-delivered webhook or the reaper racing a cancel credits back
      // exactly once. Drop-silent-with-capture (see _settleGiftCards): the
      // transition has already persisted and the webhook must return 2xx, so
      // a reversal failure surfaces loudly for reconciliation rather than
      // 500ing the request.
      // Death-edge value reversal. A cancel (pending-abandon or post-paid)
      // or a balance-clearing refund returns EVERY credit the order consumed
      // or earned, in full: refundedMinor = the order's grand total. The
      // pro-rata reversers track the cumulative already reversed (per
      // redemption / award / redeem row), so when partial refunds preceded
      // this edge they credit only the remaining delta — a partial-then-final
      // sequence converges exactly on the order total, never over-crediting.
      if (result.to === "cancelled" || result.to === "refunded") {
        var _refTotal = Number(refreshed && refreshed.grand_total_minor) || 0;
        // Gift-card spend — SYNCHRONOUS (the customer's own money), idempotent,
        // drop-silent-with-capture (see _settleGiftCards).
        await _settleGiftCards(orderId, _refTotal, _refTotal);
        if (refreshed && refreshed.customer_id && _refTotal > 0) {
          var _revCustomer = refreshed.customer_id;
          var _revOrderId  = refreshed.id;
          // Loyalty points SPENT as a checkout tender — restored to the
          // balance. Detached + drop-silent (loyalty ledger holds its own
          // audit trail); restoreRedemption claims each redeem row's slice so
          // a re-delivered webhook can't double-restore.
          if (loyalty && typeof loyalty.restoreRedemption === "function") {
            Promise.resolve().then(function () {
              return loyalty.restoreRedemption(_revOrderId, {
                refunded_minor:    _refTotal,
                order_total_minor: _refTotal,
              });
            }).catch(function () { /* drop-silent — loyalty ledger holds its own audit trail */ });
          }
          // Loyalty points EARNED on the purchase — clawed back proportionally
          // (full, on a death edge). Detached + drop-silent; clawed_points
          // makes the claw idempotent and convergent across partial slices.
          if (loyaltyEarnRules && typeof loyaltyEarnRules.reverseForEventProRata === "function") {
            Promise.resolve().then(function () {
              return loyaltyEarnRules.reverseForEventProRata({
                customer_id:       _revCustomer,
                trigger_event_ref: "order:" + _revOrderId,
                refunded_minor:    _refTotal,
                order_total_minor: _refTotal,
              });
            }).catch(function () { /* drop-silent — loyalty ledger holds its own audit trail */ });
          }
        }
        // Referral funnel — the qualifying first order being voided rolls back
        // the both-rewarded completion and decrements the referrer's count.
        // Terminal edge only (a partial refund doesn't void the order).
        // Detached + drop-silent; reverseForOrder claims the invitation with an
        // unreversed predicate so a re-delivered webhook reverses exactly once.
        if (referrals && typeof referrals.reverseForOrder === "function" && refreshed) {
          var _refrOrderId = refreshed.id;
          Promise.resolve().then(function () {
            return referrals.reverseForOrder(_refrOrderId);
          }).catch(function () { /* drop-silent — referral funnel holds its own audit trail */ });
        }
      }
      // Fan-out to merchant webhook subscribers is fire-and-forget. The
      // transition has already persisted; the request must not wait on
      // outbound HTTP, or a slow / unreachable endpoint would block the
      // transition for seconds (the HTTP client's idle timeout plus
      // retry). send() persists a delivery row per subscriber and attempts
      // delivery in the background; a failure lives in
      // `webhook_deliveries.last_error` for retry from the admin console.
      // The promise is detached with a swallowing .catch so a rejection —
      // or a synchronous throw from send() — never becomes an
      // unhandledRejection and never touches the transition's latency.
      if (webhooks && typeof webhooks.send === "function") {
        var _whPayload = {
          order: refreshed,
          transition: {
            from:     result.from,
            to:       result.to,
            on_event: event,
            reason:   (opts2 && opts2.reason) || null,
            metadata: (opts2 && opts2.metadata) || {},
            occurred_at: ts,
          },
        };
        Promise.resolve().then(function () {
          return webhooks.send("order." + event, _whPayload);
        }).catch(function () { /* drop-silent — delivery rows hold the failure */ });
      }
      // Loyalty earn-on-purchase fan-out — fire-and-forget, same
      // discipline as the webhook block. Only on the paid transition
      // and only for an order that carries a customer_id (guest orders
      // have no loyalty account to credit). The per-event dedup on
      // `loyalty_earn_log` (rule_slug, customer_id, trigger_event_ref)
      // collapses a re-delivered mark_paid (Stripe + PayPal webhook
      // backstops both fire it) onto one award, so a retried transition
      // never double-credits. dollars_spent is derived from the order
      // subtotal (the revenue the customer actually spent on goods,
      // excluding tax + shipping); per_purchase / first_purchase rules
      // ignore it. The award is detached so a loyalty failure lives in
      // the loyalty ledger's own audit trail, never as an
      // unhandledRejection and never on the transition's latency.
      if (loyaltyEarnRules && typeof loyaltyEarnRules.awardForEvent === "function"
          && result.to === "paid" && refreshed && refreshed.customer_id) {
        var _loyCustomer = refreshed.customer_id;
        var _loyOrderId  = refreshed.id;
        var _loyDollars  = Math.floor((Number(refreshed.subtotal_minor) || 0) / 100);
        Promise.resolve().then(function () {
          return loyaltyEarnRules.awardForEvent({
            trigger:           "per_dollar_spent",
            customer_id:       _loyCustomer,
            dollars_spent:     _loyDollars,
            trigger_event_ref: "order:" + _loyOrderId,
          });
        }).then(function () {
          return loyaltyEarnRules.awardForEvent({
            trigger:           "per_purchase",
            customer_id:       _loyCustomer,
            trigger_event_ref: "order:" + _loyOrderId,
          });
        }).catch(function () { /* drop-silent — loyalty ledger holds its own audit trail */ });
      }
      // Referral reward-on-first-order fan-out — fire-and-forget, same
      // discipline as the loyalty block. Only on the paid transition and
      // only for an order carrying a customer_id (a guest order has no
      // account to attribute). trackPurchase pins the buyer's FIRST
      // qualifying purchase to the invitation that referred them and
      // completes the referrer's funnel; it is idempotent (first_purchase_at
      // is written once) so a re-delivered mark_paid never double-rewards,
      // and it is a no-op for a buyer who was never referred. The promise
      // is detached so a referrals failure lives in its own tables, never
      // as an unhandledRejection and never on the transition's latency.
      if (referrals && typeof referrals.trackPurchase === "function"
          && result.to === "paid" && refreshed && refreshed.customer_id) {
        var _refCustomer = refreshed.customer_id;
        var _refOrderId  = refreshed.id;
        Promise.resolve().then(function () {
          return referrals.trackPurchase({ customer_id: _refCustomer, order_id: _refOrderId });
        }).catch(function () { /* drop-silent — referral funnel holds its own audit trail */ });
      }
      // New-order operator ping — fire-and-forget, same discipline as the
      // loyalty / referral fan-outs above. Only on the paid transition
      // (pending → paid is the edge that owns inventory debit, so this
      // fires exactly once per real sale — a re-delivered mark_paid is
      // collapsed to a no-op transition upstream). Guest orders fire too:
      // the operator wants to know a sale settled regardless of whether
      // the buyer has an account. The observer is detached so a slow /
      // failing inbox write never adds latency to (or fails) the order
      // transition; the inbox enqueue holds its own durable audit trail.
      if (newOrderObserver && result.to === "paid" && refreshed) {
        var _pingOrder = refreshed;
        Promise.resolve().then(function () {
          return newOrderObserver(_pingOrder);
        }).catch(function () { /* drop-silent — the observer owns its own failure trail */ });
      }
      return refreshed;
    },

    // Late-bind the new-order observer (see the `newOrderObserver` slot
    // in the factory). The operator-ping adapter is constructed AFTER
    // this primitive (it composes the same order handle), so the wiring
    // assigns the slot once both halves exist. A non-function is refused
    // at the boundary so a typo surfaces at boot, not as a silent
    // never-firing ping. Pass `null` to detach.
    setNewOrderObserver: function (fn) {
      if (fn != null && typeof fn !== "function") {
        throw new TypeError("order.setNewOrderObserver: observer must be a function or null");
      }
      newOrderObserver = fn || null;
    },

    // Sum of every refund recorded against this order, in minor units.
    // Both the FSM `refund` transition (full / balance-clearing refund →
    // `refunded`) and a partial-refund record (recordPartialRefund — a
    // same-state self-loop) write an `order_transitions` row whose
    // metadata carries `amount_minor`, so the running refunded total is
    // the SUM of `amount_minor` across every `on_event = 'refund'` row.
    // Rows with no amount in metadata (a legacy full refund that recorded
    // none) contribute 0 here — the partial-refund console always records
    // the amount, so a mixed history still totals correctly going forward.
    // Integer minor-unit arithmetic throughout (never a float): the values
    // are exact minor-unit integers from the order totals + provider refund
    // amounts, so the sum is exact.
    refundedTotalMinor: async function (orderId) {
      _uuid(orderId, "order id");
      var rows = (await query(
        "SELECT metadata_json FROM order_transitions " +
        "WHERE order_id = ?1 AND on_event = 'refund'",
        [orderId],
      )).rows;
      var total = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var meta;
        try { meta = JSON.parse(rows[i].metadata_json || "{}"); }
        catch (_e) { meta = {}; }
        var amt = meta && meta.amount_minor;
        if (Number.isInteger(amt) && amt > 0) total += amt;
      }
      return total;
    },

    // Record a PARTIAL refund that does NOT clear the order's balance — the
    // money has already moved at the payment provider; this appends the
    // audit row WITHOUT changing the order's FSM state (a same-state
    // self-loop `refund` transition). A partial refund leaves the order in
    // its current lifecycle state (a paid / fulfilling / shipped order keeps
    // moving) — only a balance-clearing refund drives the FSM `refund` edge
    // to the terminal `refunded` state via `transition`. The caller (the
    // admin refund console) is responsible for choosing partial-vs-final:
    // it issues the provider refund first, then calls this for a partial or
    // `transition('refund')` for the final slice. `amount_minor` is a
    // positive integer in minor units (validated here as a config/entry
    // contract — a bad amount throws so the caller surfaces a 4xx, never a
    // silently-wrong ledger row). Returns the refreshed order.
    recordPartialRefund: async function (orderId, opts2) {
      _uuid(orderId, "order id");
      opts2 = opts2 || {};
      _positiveInt(opts2.amount_minor, "amount_minor");
      var current = (await query("SELECT * FROM orders WHERE id = ?1", [orderId])).rows[0];
      if (!current) throw new TypeError("order.recordPartialRefund: order " + orderId + " not found");
      var meta = Object.assign({}, opts2.metadata || {});
      meta.amount_minor = opts2.amount_minor;
      meta.partial = true;
      // Idempotency by provider refund id. The provider refund id
      // (stripe_refund_id / paypal_refund_id, stamped by the admin console's
      // _refundLedgerMeta) is the dedupe identity — the same one the webhook
      // mirror keys on. A console double-submit (double-click, retry) or a
      // webhook arriving after a console refund computes the SAME provider
      // idempotency key, so the provider moves the money ONCE; appending a
      // second 'refund' ledger row would double-count refundedTotalMinor and,
      // on a split-tender order, drive the cash-first block below to re-credit
      // gift-card + loyalty value the customer was never actually refunded
      // (money creation). If a refund row already carries this provider refund
      // id, this call is a replay — record nothing and return the order
      // unchanged. (A truly-simultaneous race that both reads before either
      // writes is closed separately by a UNIQUE index — tracked.)
      var _refundId = (meta.stripe_refund_id || meta.paypal_refund_id) || null;
      if (_refundId) {
        var _priorRefunds = (await query(
          "SELECT metadata_json FROM order_transitions WHERE order_id = ?1 AND on_event = 'refund'",
          [orderId],
        )).rows;
        for (var _ri = 0; _ri < _priorRefunds.length; _ri += 1) {
          var _pm;
          try { _pm = JSON.parse(_priorRefunds[_ri].metadata_json || "{}"); } catch (_e) { _pm = {}; }
          if (_pm && (_pm.stripe_refund_id === _refundId || _pm.paypal_refund_id === _refundId)) {
            return await this.get(orderId);   // replay — already recorded, no-op
          }
        }
      }
      var ts = _now();
      await query(
        "INSERT INTO order_transitions (id, order_id, from_state, to_state, on_event, reason, metadata_json, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?3, 'refund', ?4, ?5, ?6)",
        [
          b.uuid.v7(), orderId, current.status,
          opts2.reason || null,
          JSON.stringify(meta),
          ts,
        ],
      );
      // updated_at is bumped so the order surfaces at the top of the
      // operator recent-orders list after a partial refund, matching how a
      // real FSM transition touches it.
      await query("UPDATE orders SET updated_at = ?1 WHERE id = ?2", [ts, orderId]);
      // Cash-first refund accounting. A partial refund returns value to the
      // CASH tender — the provider refund the operator just issued. The
      // non-cash tenders (gift-card spend, redeemed loyalty) are re-credited
      // only for the portion of the CUMULATIVE refund that exceeds the cash
      // captured at checkout; without this, refunding the cash slice of a
      // split-tender order would ALSO pro-rata re-mint the gift card, handing
      // the customer back more than the operator refunded. The provider can
      // never refund more than the cash it captured, so a cash-only partial
      // refund leaves the non-cash tenders untouched here; they are returned
      // by the terminal full-refund edge. Earned-loyalty clawback stays
      // proportional to the FULL order total — points were earned on the whole
      // order, and clawing them back is not part of the value-return path.
      var _ptTotal = Number(current.grand_total_minor) || 0;
      if (_ptTotal > 0) {
        var _ptRefunded = await this.refundedTotalMinor(orderId);
        var _split = await _orderTenderSplit(orderId);
        var _cashCaptured = _ptTotal - _split.gift - _split.loyalty;
        if (_cashCaptured < 0) _cashCaptured = 0;
        var _nonCashBack = _ptRefunded - _cashCaptured;
        if (_nonCashBack < 0) _nonCashBack = 0;
        // Exhaust the gift tender before the loyalty tender for the
        // above-cash remainder; each reverser clamps to its own tender total.
        var _giftBack = _nonCashBack < _split.gift ? _nonCashBack : _split.gift;
        var _loyaltyBack = _nonCashBack - _giftBack;
        if (_loyaltyBack > _split.loyalty) _loyaltyBack = _split.loyalty;
        if (_split.gift > 0 && _giftBack > 0) {
          await _settleGiftCards(orderId, _giftBack, _split.gift);
        }
        if (current.customer_id) {
          var _ptCust = current.customer_id;
          if (_split.loyalty > 0 && _loyaltyBack > 0 && loyalty && typeof loyalty.restoreRedemption === "function") {
            Promise.resolve().then(function () {
              return loyalty.restoreRedemption(orderId, {
                refunded_minor:    _loyaltyBack,
                order_total_minor: _split.loyalty,
              });
            }).catch(function () { /* drop-silent — loyalty ledger holds its own audit trail */ });
          }
          if (loyaltyEarnRules && typeof loyaltyEarnRules.reverseForEventProRata === "function") {
            Promise.resolve().then(function () {
              return loyaltyEarnRules.reverseForEventProRata({
                customer_id:       _ptCust,
                trigger_event_ref: "order:" + orderId,
                refunded_minor:    _ptRefunded,
                order_total_minor: _ptTotal,
              });
            }).catch(function () { /* drop-silent — loyalty ledger holds its own audit trail */ });
          }
        }
      }
      return await this.get(orderId);
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
      // Fetch one row beyond the page so the next cursor is emitted ONLY
      // when an order past this page actually exists. Keying the cursor
      // off a full page alone (rows.length === limit) advertises a
      // phantom next page when the customer's order count is an exact
      // multiple of the limit — the "Load more" link then lands on an
      // empty page.
      if (cursorVals) {
        sql = "SELECT * FROM orders WHERE customer_id = ?1 AND " +
              "(updated_at < ?2 OR (updated_at = ?2 AND id < ?3)) " +
              "ORDER BY updated_at DESC, id DESC LIMIT ?4";
        params = [customerId, cursorVals[0], cursorVals[1], limit + 1];
      } else {
        sql = "SELECT * FROM orders WHERE customer_id = ?1 " +
              "ORDER BY updated_at DESC, id DESC LIMIT ?2";
        params = [customerId, limit + 1];
      }
      var fetched = (await query(sql, params)).rows;
      var hasMore = fetched.length > limit;
      var rows    = hasMore ? fetched.slice(0, limit) : fetched;
      // Hydrate ship_to_json + lines on each row so the renderer
      // doesn't need a separate trip per order. The peeked row is sliced
      // off first so it never costs a hydration trip.
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].ship_to = JSON.parse(rows[i].ship_to_json);
        rows[i].lines   = (await query(
          "SELECT * FROM order_lines WHERE order_id = ?1 ORDER BY id ASC",
          [rows[i].id],
        )).rows;
      }
      var last = rows[rows.length - 1];
      var next = null;
      if (last && hasMore) {
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

    // Pending orders whose `created_at` is at or before `olderThanTs` —
    // the candidate set for the stale-pending-order reaper. A pending
    // order that never advanced to paid (the buyer abandoned the Stripe /
    // PayPal sheet, the PaymentIntent expired) holds its reserved stock
    // forever with no FSM edge to free it; the reaper cancels these so the
    // hold releases. Bounded (`limit`, default 100, capped at
    // MAX_LIST_LIMIT) so one tick reaps a chunk and the next picks up the
    // rest. Returns the raw row (id + payment_intent_id + created_at are
    // what the reaper needs); the reaper drives the actual hold release
    // through `transition(id, "cancel", …)`. Oldest-first so the longest-
    // stranded holds free first.
    listStalePending: async function (olderThanTs, limit) {
      if (typeof olderThanTs !== "number" || !isFinite(olderThanTs) || olderThanTs < 0) {
        throw new TypeError("order.listStalePending: olderThanTs must be a non-negative epoch-ms number");
      }
      var lim = limit == null ? 100 : limit;
      if (!Number.isInteger(lim) || lim <= 0 || lim > MAX_LIST_LIMIT) {
        throw new TypeError("order.listStalePending: limit must be 1..." + MAX_LIST_LIMIT);
      }
      var rows = (await query(
        "SELECT id, payment_intent_id, created_at FROM orders " +
        "WHERE status = 'pending' AND created_at <= ?1 " +
        "ORDER BY created_at ASC, id ASC LIMIT ?2",
        [olderThanTs, lim],
      )).rows;
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
    // email the identity provider VERIFIED (an OIDC email_verified claim)
    // or the buyer has otherwise proven control of (clicking an emailed
    // magic-link) — this method does not (and cannot) re-verify; linking
    // an unverified email would be account takeover. Only touches orders
    // with no owner yet (customer_id IS NULL), so it never re-assigns
    // another customer's order.
    //
    // Each newly-attached order also gets one append-only row in
    // guest_order_reconciliations recording WHEN it was attached, to WHICH
    // customer, by WHICH proof (linked_via), and the email_hash matched —
    // so a disputed link is traceable and an operator/DSR review can replay
    // it without inferring it from a customer_id that was overwritten. The
    // audit row is the verified linking key only (the plaintext address is
    // never stored anywhere).
    //
    // Idempotent at BOTH layers: the per-order claim-guard UPDATE only
    // flips a still-unowned order (so a re-run links nothing new), and the
    // audit INSERT is INSERT-OR-IGNORE against a UNIQUE (order_id,
    // customer_id) index (so even a forced re-write records nothing new).
    // The audit table is optional — when the migration hasn't run (a
    // partial-schema test, or a deploy mid-migration) the INSERT throws and
    // is swallowed so reconciliation never fails on the audit write; the
    // attach (the load-bearing effect) still lands.
    //
    // `linkedVia` names the proof route — defaulted + constrained to a known
    // token so a typo can't write an unfiltered string; an unknown value
    // falls back to "verified-email". Returns the count linked.
    linkGuestOrdersByEmailHash: async function (customerId, emailHash, opts2) {
      _uuid(customerId, "customer id");
      if (typeof emailHash !== "string" || !emailHash.length) {
        throw new TypeError("order.linkGuestOrdersByEmailHash: emailHash must be a non-empty string");
      }
      var linkedVia = (opts2 && opts2.linked_via) || "verified-email";
      if (RECONCILE_LINKED_VIA.indexOf(linkedVia) === -1) linkedVia = "verified-email";

      // The candidate set: every still-unowned order placed under this
      // verified email. Claiming per-id (not one bulk UPDATE) is what lets
      // the audit trail name the exact orders attached AND keeps the attach
      // race-safe — a concurrent reconciliation for the same email can't
      // double-claim because each UPDATE re-checks customer_id IS NULL.
      var candidates = (await query(
        "SELECT id FROM orders WHERE customer_id IS NULL AND customer_email_hash = ?1",
        [emailHash],
      )).rows;
      var linked = 0;
      for (var i = 0; i < candidates.length; i += 1) {
        var orderId = candidates[i].id;
        var ts = _now();
        // Claim-guard: only flip an order STILL unowned at write time.
        var upd = await query(
          "UPDATE orders SET customer_id = ?1, updated_at = ?2 " +
          "WHERE id = ?3 AND customer_id IS NULL",
          [customerId, ts, orderId],
        );
        if (Number(upd.rowCount || 0) === 0) continue; // lost the race — another writer claimed it.
        linked += 1;
        // Append-only audit row. INSERT OR IGNORE against the UNIQUE
        // (order_id, customer_id) index, so a re-run records nothing new.
        // Swallowed on a missing-table error so the attach never fails on
        // the audit write (the attach already landed above).
        try {
          await query(
            "INSERT OR IGNORE INTO guest_order_reconciliations " +
            "(id, order_id, customer_id, email_hash, linked_via, occurred_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            [b.uuid.v7(), orderId, customerId, emailHash, linkedVia, ts],
          );
        } catch (_e) { /* drop-silent — audit table optional; the attach is the load-bearing effect */ }
      }
      return linked;
    },

    // Every guest order reconciled into a customer account, newest first —
    // the operator/DSR "how did this order get attached?" view. Returns the
    // append-only audit rows (order_id, email_hash, linked_via, occurred_at)
    // for the customer; an account that never claimed a guest order returns
    // []. Defensive: when the audit table hasn't been migrated yet the read
    // throws and is collapsed to [] (the feature degrades to "no trail",
    // never a 500).
    reconciliationsForCustomer: async function (customerId) {
      _uuid(customerId, "customer id");
      try {
        var rows = (await query(
          "SELECT id, order_id, customer_id, email_hash, linked_via, occurred_at " +
          "FROM guest_order_reconciliations WHERE customer_id = ?1 " +
          "ORDER BY occurred_at DESC, id DESC",
          [customerId],
        )).rows;
        return rows;
      } catch (_e) {
        return [];
      }
    },

    // Erasure scrub for the reconciliation audit trail. The attach linkage
    // (order_id / customer_id / linked_via / occurred_at) is RETAINED under
    // the same audit basis the orders themselves carry — a disputed link
    // must stay traceable after the account is gone. But the recorded
    // email_hash is a verbatim copy of the live customer-email lookup key,
    // and account erasure deliberately severs that key on the customers
    // row, so a surviving copy here would defeat the severance for any
    // customer who ever claimed a guest order. This rewrites it to a
    // per-customer, non-reversible tombstone under its OWN hash namespace
    // ("guest-recon-erased-email" — deliberately distinct from the
    // customers row's "customer-erased-email" label, so the two tombstones
    // never share a digest and can't be correlated as the same
    // derivation). Only live (non-tombstoned) hashes rewrite, so a re-run
    // is a no-op.
    //
    // `dry_run: true` counts the rows a wet run WOULD rewrite without
    // mutating anything — the side-effect-free preview the deletion
    // pipeline's dry-run contract requires. Returns `{ table, deleted }`
    // where `deleted` is the rows tombstoned (the rows themselves stay).
    // Defensive: a schema without the audit table collapses to
    // `{ table, deleted: 0 }` (drop-silent, same posture as the sibling
    // reads) so a partial schema never fails the caller's erasure run.
    scrubReconciliationEmailHashForCustomer: async function (customerId, opts2) {
      _uuid(customerId, "customer id");
      var dryRun = !!(opts2 && opts2.dry_run);
      try {
        if (dryRun) {
          var c = (await query(
            "SELECT COUNT(*) AS n FROM guest_order_reconciliations " +
            "WHERE customer_id = ?1 AND email_hash NOT LIKE 'erased:%'",
            [customerId],
          )).rows[0];
          return { table: "guest_order_reconciliations", deleted: c ? Number(c.n) : 0 };
        }
        var tombstone = "erased:" + b.crypto.namespaceHash("guest-recon-erased-email", customerId);
        var r = await query(
          "UPDATE guest_order_reconciliations SET email_hash = ?1 " +
          "WHERE customer_id = ?2 AND email_hash NOT LIKE 'erased:%'",
          [tombstone, customerId],
        );
        return { table: "guest_order_reconciliations", deleted: Number((r && r.rowCount) || 0) };
      } catch (_e) {
        return { table: "guest_order_reconciliations", deleted: 0 };
      }
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

    // Order count per customer for a bounded set of customer ids, in ONE
    // grouped query — the operator console renders an order-count column
    // across a page of customers without an N+1. Returns a
    // { customer_id: count } map; customers with zero orders are simply
    // absent (the caller defaults to 0). An empty input short-circuits so
    // the SQL never sees `IN ()`.
    countsByCustomer: async function (customerIds) {
      if (!Array.isArray(customerIds)) {
        throw new TypeError("order.countsByCustomer: customerIds must be an array");
      }
      var out = {};
      if (customerIds.length === 0) return out;
      var placeholders = customerIds.map(function (_id, i) { return "?" + (i + 1); }).join(", ");
      var rows = (await query(
        "SELECT customer_id, COUNT(*) AS n FROM orders " +
        "WHERE customer_id IN (" + placeholders + ") GROUP BY customer_id",
        customerIds,
      )).rows;
      for (var i = 0; i < rows.length; i += 1) out[rows[i].customer_id] = Number(rows[i].n);
      return out;
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
