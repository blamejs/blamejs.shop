"use strict";
/**
 * @module shop.preorder
 * @title  Pre-order — reservations against SKUs that haven't shipped yet
 *
 * @intro
 *   Pre-order is the COUNTERPART to `backorder`. They look similar
 *   from the storefront ("can't ship today, can still take the
 *   order") but the underlying state is different:
 *
 *     - backorder = the SKU exists in the catalog, its inventory
 *       bucket is at zero, the operator commits to ship by a known
 *       restock date. The `backorder_skus` row pivots on a real
 *       `inventory.sku`.
 *     - preorder  = the SKU isn't released yet. There is no
 *       catalog stock to debit. The operator schedules a launch
 *       date and caps the reservation pool independently of any
 *       shelf count; customers reserve a unit (with or without a
 *       deposit) and the launch flow auto-converts active
 *       reservations into regular orders.
 *
 *   Lifecycle:
 *
 *     defineCampaign({ slug, sku, variant_id?, launch_at,
 *                       charge_at?, max_units_available?,
 *                       deposit_minor?, full_price_minor, currency,
 *                       marketing_copy? })
 *       Operator opens a campaign. `slug` is the URL-friendly
 *       identifier (and the PK). `launch_at` is the wall-clock
 *       moment the campaign converts; `charge_at` defaults to
 *       `launch_at` (defer billing to launch day) and can be set
 *       earlier when the operator collects up front.
 *       `max_units_available: null` (or omitted) is unlimited; a
 *       non-negative integer caps the reservation pool so the
 *       operator can't oversell against a known fab batch.
 *       `deposit_minor` defaults to 0 — the per-unit partial
 *       payment captured at reservation time; `full_price_minor`
 *       is the locked-in unit price on the eventual order line.
 *
 *     reserve({ campaign_slug, customer_id, quantity,
 *                payment_intent_id? })
 *       Refuses if the campaign isn't active, would exceed the
 *       capacity cap, or has already launched / closed. Writes a
 *       reservation row + increments the per-campaign
 *       `units_reserved` counter so the next cap check is a single
 *       read, not a COUNT(*) aggregate.
 *
 *     cancelReservation({ reservation_id, reason })
 *       Flips an active reservation to `cancelled` and decrements
 *       the per-campaign counter — the freed capacity is
 *       immediately available to subsequent `reserve` calls.
 *       Refuses on missing row or non-active status so the counter
 *       can't under-flow.
 *
 *     convertReservationToOrder({ reservation_id })
 *       Flips an active reservation to `converted` and, when an
 *       order handle is wired, composes `order.createFromCart` to
 *       land the regular order. When no handle is wired, the
 *       caller supplies the `converted_order_id` via the
 *       per-reservation field. The counter is NOT decremented on
 *       conversion — the reserved capacity is consumed by the
 *       order, not freed.
 *
 *     launchCampaign({ slug, now })
 *       Sweeps every active reservation for the campaign and runs
 *       `convertReservationToOrder` on each. Flips the campaign
 *       to `launched`. Refuses if the campaign is already launched
 *       / closed, or if `now < launch_at` (the operator can't
 *       launch ahead of the wall clock; the caller passes the
 *       monotonic clock so tests can drive it deterministically).
 *
 *     closeCampaign({ slug, reason })
 *       Operator-driven terminal flip without launching — used
 *       when a campaign is cancelled outright (fab batch fell
 *       through, design changed). Refuses if already launched
 *       / closed. Reservations remain in `active` so the operator
 *       can refund deposits through the regular order/refund
 *       surface and then cancel the reservations explicitly.
 *
 *     availability({ slug })
 *       Pure read used by the marketing page. Returns
 *       `{ remaining_units, days_until_launch, ... }` —
 *       `remaining_units` is `max_units_available - units_reserved`
 *       (or `null` for unlimited campaigns); `days_until_launch` is
 *       `ceil((launch_at - now) / 86400000)` (clamped at 0 for
 *       launched / past-due campaigns).
 *
 *   Composition:
 *     - b.guardUuid — every customer_id / reservation_id is
 *       UUID-shape-validated at the entry point.
 *     - b.uuid.v7   — preorder_reservations.id (sortable, monotonic
 *       so a tied `reservation_at` still sorts deterministically).
 *     - order (optional) — when injected,
 *       `convertReservationToOrder` composes `order.createFromCart`
 *       to land the regular order at launch. When absent, the
 *       conversion still records the status flip + lets the caller
 *       supply `converted_order_id` directly.
 *
 *   The factory accepts an optional `query` (defaults to
 *   `b.externalDb.query`), an optional `catalog` handle (currently
 *   unused — kept for future spec drift onto the catalog inventory
 *   bucket), and an optional `order` handle (composes
 *   `order.createFromCart` at conversion time when wired).
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var SLUG_RE         = /^[a-z0-9][a-z0-9-]{0,127}$/;
var SKU_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CURRENCY_RE     = /^[A-Z]{3}$/;
var MAX_COPY_LEN    = 2000;
var MAX_REASON_LEN  = 280;
var DAY_MS          = C.TIME.days(1);

var CAMPAIGN_STATUSES    = Object.freeze(["active", "launched", "closed"]);
var RESERVATION_STATUSES = Object.freeze(["active", "converted", "cancelled"]);

// ---- monotonic clock ----------------------------------------------------
//
// Two reservations recorded inside the same millisecond would otherwise
// collide on the v7-uuid timestamp prefix and tie on (reservation_at, id)
// keyset reads. The monotonic step guarantees strict-increase so the
// "newest first" customer-portal sort is deterministic without depending
// on the v7 sub-ms counter.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("preorder: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("preorder: slug must match /^[a-z0-9][a-z0-9-]*$/ (lowercase alnum + hyphen, ≤ 128 chars)");
  }
}

function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("preorder: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, ≤ 128 chars)");
  }
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("preorder: currency must be a 3-letter uppercase ISO 4217 code");
  }
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("preorder: " + label + " must be a non-negative integer (epoch ms)");
  }
}

function _epochMsOrNull(n, label) {
  if (n === null || n === undefined) return null;
  _epochMs(n, label);
  return n;
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("preorder: " + label + " must be a positive integer");
  }
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("preorder: " + label + " must be a non-negative integer");
  }
}

function _nonNegIntOrNull(n, label) {
  if (n === null || n === undefined) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("preorder: " + label + " must be a non-negative integer or null");
  }
  return n;
}

function _shortText(s, label, max) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > max) {
    throw new TypeError("preorder: " + label + " must be a string ≤ " + max + " chars");
  }
  return s;
}

function _optString(s, label, max) {
  if (s == null) return null;
  if (typeof s !== "string" || s.length === 0 || s.length > max) {
    throw new TypeError("preorder: " + label + " must be a non-empty string ≤ " + max + " chars");
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
  // catalog handle is accepted-but-unused — reserved for future drift
  // (e.g. cross-checking SKU against catalog.product.get at define
  // time). Reading it here keeps the factory shape consistent with
  // sibling primitives that DO require a catalog handle.
  if (opts.catalog != null && typeof opts.catalog !== "object") {
    throw new TypeError("preorder.create: opts.catalog must be an object when provided");
  }
  var orderHandle = opts.order || null;
  if (orderHandle && typeof orderHandle.createFromCart !== "function") {
    throw new TypeError("preorder.create: opts.order must expose createFromCart when provided");
  }

  async function _getCampaign(slug) {
    var r = await query("SELECT * FROM preorder_campaigns WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  async function _getReservation(id) {
    var r = await query("SELECT * FROM preorder_reservations WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  // Convert one active reservation. Composes the optional order handle
  // when wired; otherwise records the status flip without populating
  // `converted_order_id` (the caller can patch it later from whatever
  // order surface they used). The per-campaign counter is NOT
  // decremented on conversion — the reserved capacity is consumed by
  // the order, not freed.
  async function _convertOne(reservation, campaign, ts) {
    var convertedOrderId = null;
    if (orderHandle) {
      var orderResult = await orderHandle.createFromCart({
        customer_id: reservation.customer_id,
        lines: [{
          sku:             campaign.sku,
          variant_id:      campaign.variant_id,
          quantity:        reservation.quantity,
          unit_price_minor: campaign.full_price_minor,
          currency:        campaign.currency,
        }],
        preorder_reservation_id: reservation.id,
        preorder_campaign_slug:  campaign.slug,
      });
      convertedOrderId = orderResult && orderResult.id ? orderResult.id : null;
    }
    await query(
      "UPDATE preorder_reservations SET status = 'converted', converted_at = ?1, " +
      "converted_order_id = ?2 WHERE id = ?3 AND status = 'active'",
      [ts, convertedOrderId, reservation.id],
    );
    return convertedOrderId;
  }

  return {
    // Operator opens a campaign. Idempotent on `slug` via PK conflict
    // — re-defining a slug that already exists is refused outright so
    // the operator notices the typo (vs silently mutating an active
    // campaign).
    defineCampaign: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("preorder.defineCampaign: input object required");
      }
      _slug(input.slug);
      _sku(input.sku);
      var variantId = input.variant_id == null ? null : _uuid(input.variant_id, "variant_id");
      _epochMs(input.launch_at, "launch_at");
      var chargeAt = input.charge_at == null ? input.launch_at : input.charge_at;
      _epochMs(chargeAt, "charge_at");
      var maxUnits = _nonNegIntOrNull(input.max_units_available, "max_units_available");
      var deposit = input.deposit_minor == null ? 0 : input.deposit_minor;
      _nonNegInt(deposit, "deposit_minor");
      _nonNegInt(input.full_price_minor, "full_price_minor");
      if (deposit > input.full_price_minor) {
        throw new TypeError("preorder.defineCampaign: deposit_minor must not exceed full_price_minor");
      }
      _currency(input.currency);
      var copy = _shortText(input.marketing_copy, "marketing_copy", MAX_COPY_LEN);

      var existing = await _getCampaign(input.slug);
      if (existing) {
        throw new TypeError("preorder.defineCampaign: slug " + JSON.stringify(input.slug) + " already exists");
      }
      var ts = _now();
      await query(
        "INSERT INTO preorder_campaigns (slug, sku, variant_id, launch_at, charge_at, " +
        "max_units_available, units_reserved, deposit_minor, full_price_minor, currency, " +
        "marketing_copy, status, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, 'active', ?11, ?11)",
        [input.slug, input.sku, variantId, input.launch_at, chargeAt, maxUnits,
          deposit, input.full_price_minor, input.currency, copy, ts],
      );
      return await _getCampaign(input.slug);
    },

    getCampaign: async function (slug) {
      _slug(slug);
      return await _getCampaign(slug);
    },

    // Customer-driven reserve. Refuses when:
    //   - the campaign doesn't exist / isn't active
    //   - the requested quantity would push units_reserved past the
    //     configured cap
    //   - any input shape is wrong
    // Increments the counter in the same logical operation so the
    // next cap check is a single read.
    reserve: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("preorder.reserve: input object required");
      }
      _slug(input.campaign_slug);
      _uuid(input.customer_id, "customer_id");
      _positiveInt(input.quantity, "quantity");
      var paymentIntentId = _optString(input.payment_intent_id, "payment_intent_id", 128);

      var campaign = await _getCampaign(input.campaign_slug);
      if (!campaign) {
        throw new TypeError("preorder.reserve: campaign " + JSON.stringify(input.campaign_slug) + " not found");
      }
      if (campaign.status !== "active") {
        throw new TypeError("preorder.reserve: campaign is " + campaign.status +
          ", only active campaigns accept reservations");
      }
      if (campaign.max_units_available !== null && campaign.max_units_available !== undefined) {
        if (campaign.units_reserved + input.quantity > campaign.max_units_available) {
          throw new TypeError("preorder.reserve: would exceed max_units_available " +
            "(cap=" + campaign.max_units_available + ", reserved=" + campaign.units_reserved +
            ", requested=" + input.quantity + ")");
        }
      }

      var ts = _now();
      // Pass the monotonic ts into uuid.v7 so the 48-bit timestamp
      // prefix is strictly increasing across consecutive reservations
      // — the (id) keyset cursor used by reservationsForCustomer is
      // monotonic without depending on Date.now() ticking between
      // calls.
      var id = b.uuid.v7({ now: ts });
      await query(
        "INSERT INTO preorder_reservations (id, campaign_slug, customer_id, quantity, " +
        "payment_intent_id, status, reservation_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)",
        [id, input.campaign_slug, input.customer_id, input.quantity, paymentIntentId, ts],
      );
      await query(
        "UPDATE preorder_campaigns SET units_reserved = units_reserved + ?1, updated_at = ?2 " +
        "WHERE slug = ?3",
        [input.quantity, ts, input.campaign_slug],
      );
      return await _getReservation(id);
    },

    getReservation: async function (reservationId) {
      _uuid(reservationId, "reservation_id");
      return await _getReservation(reservationId);
    },

    // Customer-portal read — every reservation a customer holds,
    // newest first. The v7-uuid PK encodes the monotonic timestamp so
    // `ORDER BY id DESC` matches `ORDER BY reservation_at DESC` without
    // a second index.
    reservationsForCustomer: async function (customerId, listOpts) {
      _uuid(customerId, "customer_id");
      listOpts = listOpts || {};
      var sql, params;
      if (listOpts.status != null) {
        if (RESERVATION_STATUSES.indexOf(listOpts.status) === -1) {
          throw new TypeError("preorder.reservationsForCustomer: status must be one of " +
            RESERVATION_STATUSES.join(", "));
        }
        sql = "SELECT * FROM preorder_reservations WHERE customer_id = ?1 AND status = ?2 ORDER BY id DESC";
        params = [customerId, listOpts.status];
      } else {
        sql = "SELECT * FROM preorder_reservations WHERE customer_id = ?1 ORDER BY id DESC";
        params = [customerId];
      }
      var r = await query(sql, params);
      return r.rows;
    },

    // Flip an active reservation to cancelled. Decrements the
    // per-campaign counter so the freed capacity is immediately
    // available to subsequent `reserve` calls. Refuses missing row or
    // non-active status so the counter can never under-flow. MAX(0,
    // ...) clamps the counter against out-of-band corruption.
    cancelReservation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("preorder.cancelReservation: input object required");
      }
      _uuid(input.reservation_id, "reservation_id");
      var reason = _shortText(input.reason, "reason", MAX_REASON_LEN);
      var reservation = await _getReservation(input.reservation_id);
      if (!reservation) {
        throw new TypeError("preorder.cancelReservation: reservation " +
          JSON.stringify(input.reservation_id) + " not found");
      }
      if (reservation.status !== "active") {
        throw new TypeError("preorder.cancelReservation: reservation is " + reservation.status +
          ", only active reservations can be cancelled");
      }
      var ts = _now();
      await query(
        "UPDATE preorder_reservations SET status = 'cancelled', cancelled_at = ?1, " +
        "cancel_reason = ?2 WHERE id = ?3",
        [ts, reason, reservation.id],
      );
      await query(
        "UPDATE preorder_campaigns SET units_reserved = MAX(0, units_reserved - ?1), " +
        "updated_at = ?2 WHERE slug = ?3",
        [reservation.quantity, ts, reservation.campaign_slug],
      );
      return await _getReservation(reservation.id);
    },

    // Convert one reservation explicitly. The launch flow calls this
    // verb in a loop via `launchCampaign`; operators can also call it
    // out-of-band when a campaign is structured for rolling
    // conversions ahead of the launch wall-clock.
    convertReservationToOrder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("preorder.convertReservationToOrder: input object required");
      }
      _uuid(input.reservation_id, "reservation_id");
      var reservation = await _getReservation(input.reservation_id);
      if (!reservation) {
        throw new TypeError("preorder.convertReservationToOrder: reservation " +
          JSON.stringify(input.reservation_id) + " not found");
      }
      if (reservation.status !== "active") {
        throw new TypeError("preorder.convertReservationToOrder: reservation is " + reservation.status +
          ", only active reservations can be converted");
      }
      var campaign = await _getCampaign(reservation.campaign_slug);
      if (!campaign) {
        throw new TypeError("preorder.convertReservationToOrder: campaign " +
          JSON.stringify(reservation.campaign_slug) + " not found");
      }
      var ts = _now();
      var orderId = await _convertOne(reservation, campaign, ts);
      return {
        reservation_id:     reservation.id,
        converted_order_id: orderId,
        status:             "converted",
      };
    },

    // Launch the campaign: walk every active reservation and convert
    // each to a regular order. Flips the campaign to `launched`.
    // Refuses if already launched / closed, or if now < launch_at —
    // the caller passes the monotonic clock so tests can drive it
    // deterministically.
    launchCampaign: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("preorder.launchCampaign: input object required");
      }
      _slug(input.slug);
      _epochMs(input.now, "now");
      var campaign = await _getCampaign(input.slug);
      if (!campaign) {
        throw new TypeError("preorder.launchCampaign: campaign " +
          JSON.stringify(input.slug) + " not found");
      }
      if (campaign.status !== "active") {
        throw new TypeError("preorder.launchCampaign: campaign is " + campaign.status +
          ", only active campaigns can be launched");
      }
      if (input.now < campaign.launch_at) {
        throw new TypeError("preorder.launchCampaign: now (" + input.now +
          ") is before launch_at (" + campaign.launch_at + ")");
      }
      var activeRows = (await query(
        "SELECT * FROM preorder_reservations WHERE campaign_slug = ?1 AND status = 'active' " +
        "ORDER BY id ASC",
        [input.slug],
      )).rows;
      var ts = _now();
      var converted = [];
      for (var i = 0; i < activeRows.length; i += 1) {
        var orderId = await _convertOne(activeRows[i], campaign, ts);
        converted.push({ reservation_id: activeRows[i].id, converted_order_id: orderId });
      }
      await query(
        "UPDATE preorder_campaigns SET status = 'launched', launched_at = ?1, updated_at = ?1 " +
        "WHERE slug = ?2",
        [ts, input.slug],
      );
      return {
        slug:              input.slug,
        launched_at:       ts,
        converted_count:   converted.length,
        conversions:       converted,
      };
    },

    // Operator-driven terminal flip without launching — used when a
    // campaign is cancelled outright. Reservations remain in `active`
    // so the operator can refund deposits through the regular
    // order/refund surface and then cancel the reservations
    // explicitly.
    closeCampaign: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("preorder.closeCampaign: input object required");
      }
      _slug(input.slug);
      var reason = _shortText(input.reason, "reason", MAX_REASON_LEN);
      var campaign = await _getCampaign(input.slug);
      if (!campaign) {
        throw new TypeError("preorder.closeCampaign: campaign " +
          JSON.stringify(input.slug) + " not found");
      }
      if (campaign.status !== "active") {
        throw new TypeError("preorder.closeCampaign: campaign is " + campaign.status +
          ", only active campaigns can be closed");
      }
      var ts = _now();
      await query(
        "UPDATE preorder_campaigns SET status = 'closed', closed_at = ?1, close_reason = ?2, " +
        "updated_at = ?1 WHERE slug = ?3",
        [ts, reason, input.slug],
      );
      return await _getCampaign(input.slug);
    },

    // Pure read used by the marketing page. `remaining_units` is
    // `max_units_available - units_reserved` (or `null` for unlimited
    // campaigns); `days_until_launch` is `ceil((launch_at - now) /
    // DAY_MS)` (clamped at 0 for launched / past-due campaigns).
    availability: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("preorder.availability: input object required");
      }
      _slug(input.slug);
      var campaign = await _getCampaign(input.slug);
      if (!campaign) {
        return null;
      }
      var remaining;
      if (campaign.max_units_available == null) {
        remaining = null;
      } else {
        remaining = campaign.max_units_available - campaign.units_reserved;
        if (remaining < 0) { remaining = 0; }
      }
      var now = _now();
      var msUntil = campaign.launch_at - now;
      var days;
      if (msUntil <= 0) {
        days = 0;
      } else {
        days = Math.ceil(msUntil / DAY_MS);
      }
      return {
        slug:              campaign.slug,
        status:            campaign.status,
        remaining_units:   remaining,
        units_reserved:    campaign.units_reserved,
        max_units_available: campaign.max_units_available,
        days_until_launch: days,
        launch_at:         campaign.launch_at,
        charge_at:         campaign.charge_at,
        full_price_minor:  campaign.full_price_minor,
        deposit_minor:     campaign.deposit_minor,
        currency:          campaign.currency,
      };
    },
  };
}

module.exports = {
  create:                 create,
  CAMPAIGN_STATUSES:      CAMPAIGN_STATUSES,
  RESERVATION_STATUSES:   RESERVATION_STATUSES,
};
