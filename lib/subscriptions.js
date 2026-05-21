"use strict";
/**
 * @module shop.subscriptions
 * @title  Subscriptions primitive — Stripe-backed recurring billing
 *
 * @intro
 *   Two surfaces share one factory:
 *
 *     var subs = bShop.subscriptions.create({ query: q, payment: pay });
 *     subs.plans.create({ ... });
 *     subs.subscriptions.create({ customer_id, plan_id, payment_method_id });
 *
 *   `plans` is the catalog-side recurring offer (CRUD over
 *   `subscription_plans`). Operators pre-create the recurring Price
 *   in Stripe and pass the `stripe_price_id` into `plans.create` —
 *   Stripe stays the pricing source of truth; the shop mirrors the
 *   id + interval + amount locally so the storefront can render the
 *   plan without a network hop.
 *
 *   `subscriptions` binds customers to plans. `subscriptions.create`
 *   composes `payment.subscriptions.create` (Stripe API) and
 *   persists the returned subscription locally. The webhook
 *   handler (`handleStripeEvent`) replays
 *   `customer.subscription.created/updated/deleted` events into
 *   the local row so the shop's view stays authoritative without
 *   round-tripping to Stripe on every read.
 *
 *   Status values mirror Stripe's enum exactly (trialing, active,
 *   past_due, canceled, incomplete, incomplete_expired, unpaid) so
 *   a webhook payload's `status` field replays into the row
 *   without translation.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var INTERVALS    = ["day", "week", "month", "year"];
var STATUSES     = ["trialing", "active", "past_due", "canceled", "incomplete", "incomplete_expired", "unpaid"];
var CURRENCY_RE  = /^[a-z]{3}$/;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("subscriptions: " + label + " — " + (e && e.message || "invalid UUID")); }
}
function _nonEmptyString(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("subscriptions: " + label + " must be a non-empty string");
  }
}
function _interval(s) {
  if (typeof s !== "string" || INTERVALS.indexOf(s) === -1) {
    throw new TypeError("subscriptions: interval must be one of " + INTERVALS.join(", "));
  }
}
function _intervalCount(n) {
  if (!Number.isInteger(n) || n < 1 || n > 12) {
    throw new TypeError("subscriptions: interval_count must be an integer in [1, 12]");
  }
}
function _trialDays(n) {
  if (!Number.isInteger(n) || n < 0 || n > 730) {
    throw new TypeError("subscriptions: trial_days must be an integer in [0, 730]");
  }
}
function _currency(c) {
  if (typeof c !== "string" || !CURRENCY_RE.test(c)) {
    throw new TypeError("subscriptions: currency must be 3-letter lowercase ISO 4217");
  }
}
function _amountMinor(n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("subscriptions: amount_minor must be a positive integer (minor units)");
  }
}
function _status(s) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError("subscriptions: status must be one of " + STATUSES.join(", "));
  }
}

function _now() { return Date.now(); }

// ---- plans factory ------------------------------------------------------

function _makePlans(query) {
  return {
    create: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("subscriptions.plans.create: input object required");
      if (input.variant_id != null) _uuid(input.variant_id, "variant_id");
      _nonEmptyString(input.stripe_price_id, "stripe_price_id");
      _interval(input.interval);
      var intervalCount = input.interval_count == null ? 1 : input.interval_count;
      _intervalCount(intervalCount);
      _currency(input.currency);
      _amountMinor(input.amount_minor);
      var trialDays = input.trial_days == null ? 0 : input.trial_days;
      _trialDays(trialDays);
      var active = input.active === false ? 0 : 1;

      var id = _b().uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
        "currency, amount_minor, trial_days, active, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        [
          id, input.variant_id || null, input.stripe_price_id, input.interval,
          intervalCount, input.currency, input.amount_minor, trialDays, active, ts,
        ],
      );
      return await this.get(id);
    },

    get: async function (id) {
      _uuid(id, "plan id");
      var r = await query("SELECT * FROM subscription_plans WHERE id = ?1", [id]);
      return r.rows.length ? r.rows[0] : null;
    },

    list: async function (input) {
      input = input || {};
      var sql = "SELECT * FROM subscription_plans";
      var params = [];
      var where = [];
      if (input.variant_id != null) {
        _uuid(input.variant_id, "variant_id");
        where.push("variant_id = ?" + (params.length + 1));
        params.push(input.variant_id);
      }
      if (input.active != null) {
        where.push("active = ?" + (params.length + 1));
        params.push(input.active ? 1 : 0);
      }
      if (where.length) sql += " WHERE " + where.join(" AND ");
      sql += " ORDER BY created_at DESC";
      var r = await query(sql, params);
      return r.rows;
    },

    update: async function (id, input) {
      _uuid(id, "plan id");
      if (!input || typeof input !== "object") throw new TypeError("subscriptions.plans.update: input object required");
      var sets = [];
      var params = [];
      // Whitelist mutable columns; stripe_price_id + interval + currency
      // are immutable post-create because they bind the Stripe Price
      // we already mirror — operator must archive + recreate to
      // change those.
      if (input.amount_minor != null) {
        _amountMinor(input.amount_minor);
        sets.push("amount_minor = ?" + (params.length + 1));
        params.push(input.amount_minor);
      }
      if (input.interval_count != null) {
        _intervalCount(input.interval_count);
        sets.push("interval_count = ?" + (params.length + 1));
        params.push(input.interval_count);
      }
      if (input.trial_days != null) {
        _trialDays(input.trial_days);
        sets.push("trial_days = ?" + (params.length + 1));
        params.push(input.trial_days);
      }
      if (input.active != null) {
        sets.push("active = ?" + (params.length + 1));
        params.push(input.active ? 1 : 0);
      }
      if (input.variant_id !== undefined) {
        if (input.variant_id !== null) _uuid(input.variant_id, "variant_id");
        sets.push("variant_id = ?" + (params.length + 1));
        params.push(input.variant_id);
      }
      if (sets.length === 0) return await this.get(id);
      var ts = _now();
      sets.push("updated_at = ?" + (params.length + 1));
      params.push(ts);
      params.push(id);
      var r = await query(
        "UPDATE subscription_plans SET " + sets.join(", ") + " WHERE id = ?" + params.length,
        params,
      );
      if (r.rowCount === 0) return null;
      return await this.get(id);
    },

    archive: async function (id) {
      _uuid(id, "plan id");
      var ts = _now();
      var r = await query(
        "UPDATE subscription_plans SET active = 0, updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      if (r.rowCount === 0) return null;
      return await this.get(id);
    },
  };
}

// ---- subscriptions factory ----------------------------------------------

// Map Stripe webhook event types → local handler verb.
var STRIPE_SUB_EVENT_MAP = Object.freeze({
  "customer.subscription.created": "upsert",
  "customer.subscription.updated": "upsert",
  "customer.subscription.deleted": "delete",
});

function _extractFromStripeObject(obj) {
  // Stripe nests current_period_start/_end at the top level when the
  // event is `customer.subscription.*`. Both are unix seconds; we
  // store epoch ms.
  var periodStart = obj && obj.current_period_start != null ? obj.current_period_start * 1000 : null;
  var periodEnd   = obj && obj.current_period_end   != null ? obj.current_period_end   * 1000 : null;
  return {
    stripe_subscription_id: obj && obj.id,
    status:                 obj && obj.status,
    current_period_start:   periodStart,
    current_period_end:     periodEnd,
    cancel_at_period_end:   obj && obj.cancel_at_period_end ? 1 : 0,
  };
}

function _makeSubscriptions(query, payment, plans) {
  return {
    create: async function (input) {
      if (!input || typeof input !== "object") throw new TypeError("subscriptions.create: input object required");
      _nonEmptyString(input.customer_id, "customer_id");
      _uuid(input.plan_id, "plan_id");
      _nonEmptyString(input.payment_method_id, "payment_method_id");

      var plan = await plans.get(input.plan_id);
      if (!plan) throw new TypeError("subscriptions.create: plan " + input.plan_id + " not found");
      if (!plan.active) throw new TypeError("subscriptions.create: plan " + input.plan_id + " is archived");

      // The local row holds the Stripe-source-of-truth identity +
      // status. We post to Stripe FIRST so the row only lands on
      // success — half-create followed by Stripe-side failure leaves
      // no orphan row in the shop's view.
      var stripeInput = {
        customer:               input.customer_id,
        items:                  [{ price: plan.stripe_price_id }],
        default_payment_method: input.payment_method_id,
        expand:                 ["latest_invoice.payment_intent"],
      };
      if (plan.trial_days > 0) stripeInput.trial_period_days = plan.trial_days;
      if (input.metadata) stripeInput.metadata = input.metadata;

      var idemKey = input.idempotency_key || ("sub:" + input.customer_id + ":" + input.plan_id);
      var stripeSub = await payment.subscriptions.create(stripeInput, idemKey);
      if (!stripeSub || !stripeSub.id || !stripeSub.status) {
        throw new Error("subscriptions.create: Stripe response missing id/status");
      }

      var id = _b().uuid.v7();
      var ts = _now();
      var ex = _extractFromStripeObject(stripeSub);
      _status(ex.status);
      await query(
        "INSERT INTO subscriptions (id, customer_id, plan_id, stripe_subscription_id, status, " +
        "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        [
          id, input.customer_id, input.plan_id, ex.stripe_subscription_id, ex.status,
          ex.current_period_start, ex.current_period_end, ex.cancel_at_period_end, ts,
        ],
      );
      return await this.get(id);
    },

    get: async function (id) {
      _uuid(id, "subscription id");
      var r = await query("SELECT * FROM subscriptions WHERE id = ?1", [id]);
      return r.rows.length ? r.rows[0] : null;
    },

    byStripeId: async function (stripeId) {
      _nonEmptyString(stripeId, "stripe subscription id");
      var r = await query("SELECT * FROM subscriptions WHERE stripe_subscription_id = ?1", [stripeId]);
      return r.rows.length ? r.rows[0] : null;
    },

    list: async function (input) {
      input = input || {};
      var sql = "SELECT * FROM subscriptions";
      var params = [];
      var where = [];
      if (input.customer_id != null) {
        _nonEmptyString(input.customer_id, "customer_id");
        where.push("customer_id = ?" + (params.length + 1));
        params.push(input.customer_id);
      }
      if (input.status != null) {
        _status(input.status);
        where.push("status = ?" + (params.length + 1));
        params.push(input.status);
      }
      if (where.length) sql += " WHERE " + where.join(" AND ");
      sql += " ORDER BY created_at DESC";
      var r = await query(sql, params);
      return r.rows;
    },

    cancel: async function (id, opts) {
      _uuid(id, "subscription id");
      opts = opts || {};
      var atPeriodEnd = !!opts.at_period_end;
      var row = await this.get(id);
      if (!row) return null;
      var idemKey = opts.idempotency_key || ("cancel:" + id + ":" + (atPeriodEnd ? "ape" : "now"));
      var stripeSub = await payment.subscriptions.cancel(
        row.stripe_subscription_id,
        { at_period_end: atPeriodEnd },
        idemKey,
      );
      if (!stripeSub || !stripeSub.id) {
        throw new Error("subscriptions.cancel: Stripe response missing id");
      }
      var ex = _extractFromStripeObject(stripeSub);
      _status(ex.status);
      var ts = _now();
      await query(
        "UPDATE subscriptions SET status = ?1, current_period_start = ?2, current_period_end = ?3, " +
        "cancel_at_period_end = ?4, updated_at = ?5 WHERE id = ?6",
        [ex.status, ex.current_period_start, ex.current_period_end, ex.cancel_at_period_end, ts, id],
      );
      return await this.get(id);
    },

    // Replays a Stripe webhook event (`customer.subscription.*`) into
    // the local row. Returns `{ handled, action, subscription? }`.
    // Unknown event types return `{ handled: false }`. Webhook
    // signature verification happens upstream in checkout.handleStripeEvent.
    handleStripeEvent: async function (event) {
      if (!event || typeof event !== "object") throw new TypeError("subscriptions.handleStripeEvent: event object required");
      var type = event.type;
      if (!type || !Object.prototype.hasOwnProperty.call(STRIPE_SUB_EVENT_MAP, type)) {
        return { handled: false, event_type: type || null };
      }
      var obj = event.data && event.data.object;
      if (!obj || !obj.id) return { handled: false, event_type: type, reason: "no-subscription-object" };

      var action = STRIPE_SUB_EVENT_MAP[type];
      var existing = await this.byStripeId(obj.id);

      if (action === "delete") {
        if (!existing) return { handled: false, event_type: type, reason: "subscription-not-found" };
        var ex = _extractFromStripeObject(obj);
        // Stripe sets status to "canceled" on delete; mirror that.
        var status = ex.status || "canceled";
        _status(status);
        var ts = _now();
        await query(
          "UPDATE subscriptions SET status = ?1, current_period_start = ?2, current_period_end = ?3, " +
          "cancel_at_period_end = ?4, updated_at = ?5 WHERE id = ?6",
          [status, ex.current_period_start, ex.current_period_end, ex.cancel_at_period_end, ts, existing.id],
        );
        return { handled: true, event_type: type, action: action, subscription: await this.get(existing.id) };
      }

      // action === "upsert"
      var ex2 = _extractFromStripeObject(obj);
      if (!ex2.status) return { handled: false, event_type: type, reason: "no-status" };
      _status(ex2.status);
      var ts2 = _now();
      if (existing) {
        await query(
          "UPDATE subscriptions SET status = ?1, current_period_start = ?2, current_period_end = ?3, " +
          "cancel_at_period_end = ?4, updated_at = ?5 WHERE id = ?6",
          [ex2.status, ex2.current_period_start, ex2.current_period_end, ex2.cancel_at_period_end, ts2, existing.id],
        );
        return { handled: true, event_type: type, action: action, subscription: await this.get(existing.id) };
      }
      // No local row — `created` arrived before our subscriptions.create
      // could finish persisting (unlikely), OR the subscription was
      // created out-of-band in Stripe. Without the link to a local
      // plan_id we can't insert a complete row; surface as
      // not-found so the operator can reconcile.
      return { handled: false, event_type: type, reason: "subscription-not-found" };
    },
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  var payment = opts.payment || null;
  var plans = _makePlans(query);
  var subscriptions = _makeSubscriptions(query, payment, plans);
  return {
    plans:         plans,
    subscriptions: subscriptions,
  };
}

module.exports = {
  create:               create,
  INTERVALS:            INTERVALS,
  STATUSES:             STATUSES,
  STRIPE_SUB_EVENT_MAP: STRIPE_SUB_EVENT_MAP,
};
