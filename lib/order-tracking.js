"use strict";
/**
 * @module shop.orderTracking
 * @title  Order tracking — shipment + carrier-event ledger
 *
 * @intro
 *   Once an order is paid + fulfilling, the operator hands the package
 *   to a carrier. The tracking primitive is the post-handoff ledger:
 *   one `shipments` row per parcel (split shipments allowed — a single
 *   order can produce multiple shipments when items ship from
 *   different warehouses or one item backorders), and one
 *   `shipment_events` row per carrier scan / operator-recorded status
 *   change.
 *
 *   Lifecycle (see migration 0021_shipments.sql for the storage CHECK):
 *
 *     pending           — row created, no carrier label yet
 *     label-created     — operator generated the shipping label
 *     in-transit        — carrier picked up
 *     out-for-delivery  — carrier final-mile underway
 *     delivered         — confirmed delivery
 *     exception         — carrier-reported problem
 *     returned          — package en route back / received back
 *
 *   `recordEvent` is the operator-facing append-and-update — it adds
 *   a row to `shipment_events` and updates `shipments.status` to the
 *   event's status. Idempotent on duplicate `(shipment_id, status,
 *   occurred_at)` triples so a carrier webhook that fires twice for
 *   the same scan doesn't double-write.
 *
 *   `markShipped` + `markDelivered` are the two thin convenience
 *   wrappers around `recordEvent` that the checkout / fulfillment
 *   flow uses. When `order` is wired into the factory, `markDelivered`
 *   ALSO drives the parent order through `order.transition(...,
 *   "mark_delivered")` so the order FSM reflects fulfillment without
 *   a second operator call.
 *
 *   `trackingUrl` is a pure helper — given a carrier code and tracking
 *   number, return the well-known carrier tracking URL or null. The
 *   templates are public-knowledge carrier URLs (UPS / FedEx / USPS /
 *   DHL / Royal Mail / Canada Post / Australia Post). 'other' returns
 *   null — the operator surfaces a carrier-specific URL out of band.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var CARRIERS = Object.freeze([
  "ups",
  "fedex",
  "usps",
  "dhl",
  "royal-mail",
  "canada-post",
  "australia-post",
  "other",
]);

var STATUSES = Object.freeze([
  "pending",
  "label-created",
  "in-transit",
  "out-for-delivery",
  "delivered",
  "exception",
  "returned",
]);

var MAX_TRACKING_LEN      = 64;
var MAX_LOCATION_LEN      = 128;
var MAX_DETAIL_LEN        = 512;
var MAX_NOTES_LEN         = 2048;
var MAX_CARRIER_OTHER_LEN = 64;

// Carrier-specific tracking URL templates. Each function returns the
// well-known public URL for the given tracking number, already
// encoded. Kept as plain functions (not a `${...}` template lookup)
// so the templates that need a different query-param shape — Royal
// Mail uses `trackNumber`, USPS uses `qtc_tLabels1`, Canada Post uses
// `trackingNumber` — stay easy to read in source.
var CARRIER_URL = {
  "ups": function (n) {
    return "https://www.ups.com/track?tracknum=" + encodeURIComponent(n);
  },
  "fedex": function (n) {
    return "https://www.fedex.com/fedextrack/?trknbr=" + encodeURIComponent(n);
  },
  "usps": function (n) {
    return "https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=" + encodeURIComponent(n);
  },
  "dhl": function (n) {
    return "https://www.dhl.com/global-en/home/tracking.html?tracking-id=" + encodeURIComponent(n);
  },
  "royal-mail": function (n) {
    return "https://www.royalmail.com/track-your-item#/tracking-results/" + encodeURIComponent(n);
  },
  "canada-post": function (n) {
    return "https://www.canadapost-postescanada.ca/track-reperage/en#/details/" + encodeURIComponent(n);
  },
  "australia-post": function (n) {
    return "https://auspost.com.au/mypost/track/#/details/" + encodeURIComponent(n);
  },
  "other": function () { return null; },
};

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("order-tracking: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _carrier(c) {
  if (typeof c !== "string" || CARRIERS.indexOf(c) === -1) {
    throw new TypeError("order-tracking: carrier must be one of " + CARRIERS.join(", "));
  }
  return c;
}

function _status(s) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError("order-tracking: status must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("order-tracking: " + label + " must be a non-negative integer");
  }
}

function _currency(c) {
  if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("order-tracking: cost_currency must be 3-letter uppercase ISO 4217");
  }
}

// Codepoint scan refuses every C0 control byte (0x00..0x1f) + DEL
// (0x7f). Implemented as a `charCodeAt` walk rather than a regex
// literal so the `no-control-regex` ESLint rule stays clean — same
// approach blamejs uses in `lib/auth/ciba.js` + `lib/auth/step-up.js`.
function _hasStrictControlByte(s) {
  for (var i = 0; i < s.length; i += 1) {
    var cc = s.charCodeAt(i);
    if (cc <= 0x1f || cc === 0x7f) return true;
  }
  return false;
}

// Same scan but tolerant of tab / LF / CR — operator notes legitimately
// span lines, and a paste from a carrier portal that lands a `\r\n`
// pair shouldn't trip the refusal.
function _hasFreeTextControlByte(s) {
  for (var i = 0; i < s.length; i += 1) {
    var cc = s.charCodeAt(i);
    if (cc === 0x09 || cc === 0x0a || cc === 0x0d) continue;
    if (cc <= 0x1f || cc === 0x7f) return true;
  }
  return false;
}

function _trackingNumber(n) {
  // Tracking numbers are operator-supplied free-form strings — carriers
  // use everything from raw decimal digits (USPS 22-digit) to mixed
  // alphanumeric (UPS 1Z...) to internal SKU-style separators. Refuse
  // control bytes + cap length so a pathological input can't blow out
  // storage; otherwise let the operator pass through whatever the
  // carrier prints on the label.
  if (typeof n !== "string" || !n.length) {
    throw new TypeError("order-tracking: tracking_number must be a non-empty string when provided");
  }
  if (n.length > MAX_TRACKING_LEN) {
    throw new TypeError("order-tracking: tracking_number must be <= " + MAX_TRACKING_LEN + " chars");
  }
  if (_hasStrictControlByte(n)) {
    throw new TypeError("order-tracking: tracking_number must not contain control characters");
  }
  return n;
}

function _freeText(s, label, maxLen) {
  if (s == null || s === "") return "";
  if (typeof s !== "string") {
    throw new TypeError("order-tracking: " + label + " must be a string");
  }
  if (s.length > maxLen) {
    throw new TypeError("order-tracking: " + label + " must be <= " + maxLen + " chars");
  }
  if (_hasFreeTextControlByte(s)) {
    throw new TypeError("order-tracking: " + label + " must not contain control characters");
  }
  return s;
}

function _epochMs(ts, label) {
  if (ts == null) return null;
  if (!Number.isInteger(ts) || ts <= 0) {
    throw new TypeError("order-tracking: " + label + " must be a positive integer epoch-ms");
  }
  return ts;
}

function _now() { return Date.now(); }

// ---- pure URL helper (exported standalone too) -------------------------

function trackingUrl(carrier, trackingNumber) {
  if (typeof carrier !== "string" || CARRIERS.indexOf(carrier) === -1) return null;
  if (typeof trackingNumber !== "string" || !trackingNumber.length) return null;
  var build = CARRIER_URL[carrier];
  if (typeof build !== "function") return null;
  return build(trackingNumber);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Optional order primitive wiring — when wired, `markDelivered`
  // also drives the parent order through `order.transition(...,
  // "mark_delivered")` so the order FSM reflects delivery without a
  // second operator call. Kept optional so tests + standalone
  // operators can use the shipment ledger without the order FSM.
  var orderPrim = opts.order || null;
  if (orderPrim && typeof orderPrim.transition !== "function") {
    throw new TypeError("order-tracking.create: opts.order must expose a transition(id, event, opts) method");
  }

  // Internal: append an event row + update shipments.status. Idempotent
  // on `(shipment_id, status, occurred_at)` — a duplicate carrier
  // webhook fire-twice doesn't double-write.
  async function _appendEvent(shipmentId, status, location, detail, occurredAt) {
    var ts  = _now();
    var dup = await query(
      "SELECT id FROM shipment_events WHERE shipment_id = ?1 AND status = ?2 AND occurred_at = ?3 LIMIT 1",
      [shipmentId, status, occurredAt],
    );
    if (dup.rows.length) {
      return { id: dup.rows[0].id, duplicate: true };
    }
    var id = _b().uuid.v7();
    await query(
      "INSERT INTO shipment_events (id, shipment_id, status, location, detail, occurred_at, recorded_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      [id, shipmentId, status, location, detail, occurredAt, ts],
    );
    await query(
      "UPDATE shipments SET status = ?1, updated_at = ?2 WHERE id = ?3",
      [status, ts, shipmentId],
    );
    return { id: id, duplicate: false };
  }

  async function _getShipmentRow(shipmentId) {
    var r = await query("SELECT * FROM shipments WHERE id = ?1", [shipmentId]);
    return r.rows[0] || null;
  }

  return {
    CARRIERS: CARRIERS,
    STATUSES: STATUSES,

    // Pure helper, also exposed on the instance for ergonomics.
    trackingUrl: trackingUrl,

    createShipment: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("order-tracking.createShipment: input object required");
      }
      _uuid(input.order_id, "order_id");
      _carrier(input.carrier);

      var trackingNumber = null;
      if (input.tracking_number != null && input.tracking_number !== "") {
        trackingNumber = _trackingNumber(input.tracking_number);
      }

      var carrierOther = null;
      if (input.carrier === "other") {
        if (typeof input.carrier_other_name !== "string" || !input.carrier_other_name.length) {
          throw new TypeError("order-tracking.createShipment: carrier_other_name required when carrier='other'");
        }
        carrierOther = _freeText(input.carrier_other_name, "carrier_other_name", MAX_CARRIER_OTHER_LEN);
      } else if (input.carrier_other_name != null) {
        // Defensive — surface the contradiction rather than silently
        // dropping operator intent.
        throw new TypeError("order-tracking.createShipment: carrier_other_name only valid when carrier='other'");
      }

      var weight = input.weight_grams == null ? 0 : input.weight_grams;
      _nonNegInt(weight, "weight_grams");

      var costMinor = input.cost_minor == null ? 0 : input.cost_minor;
      _nonNegInt(costMinor, "cost_minor");

      var costCurrency = input.cost_currency == null ? "USD" : input.cost_currency;
      _currency(costCurrency);

      var notes = _freeText(input.notes, "notes", MAX_NOTES_LEN);

      // Verify the parent order exists. The SQL FK enforces this too,
      // but a TypeError up-front gives a clearer operator-facing
      // message than the raw SQLITE_CONSTRAINT bubble.
      var parent = await query("SELECT id FROM orders WHERE id = ?1", [input.order_id]);
      if (!parent.rows.length) {
        throw new TypeError("order-tracking.createShipment: order " + input.order_id + " not found");
      }

      var id = _b().uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO shipments (id, order_id, tracking_number, carrier, carrier_other_name, " +
        "status, shipped_at, delivered_at, estimated_delivery_at, weight_grams, cost_minor, " +
        "cost_currency, notes, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, 'pending', NULL, NULL, NULL, ?6, ?7, ?8, ?9, ?10, ?10)",
        [
          id, input.order_id, trackingNumber, input.carrier, carrierOther,
          weight, costMinor, costCurrency, notes, ts,
        ],
      );

      return {
        id:           id,
        tracking_url: trackingUrl(input.carrier, trackingNumber),
      };
    },

    recordEvent: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("order-tracking.recordEvent: input object required");
      }
      _uuid(input.shipment_id, "shipment_id");
      _status(input.status);
      var location  = _freeText(input.location, "location", MAX_LOCATION_LEN);
      var detail    = _freeText(input.detail,   "detail",   MAX_DETAIL_LEN);
      var occurred  = input.occurred_at == null ? _now() : _epochMs(input.occurred_at, "occurred_at");

      var row = await _getShipmentRow(input.shipment_id);
      if (!row) {
        throw new TypeError("order-tracking.recordEvent: shipment " + input.shipment_id + " not found");
      }

      var r = await _appendEvent(input.shipment_id, input.status, location, detail, occurred);
      return {
        id:          r.id,
        shipment_id: input.shipment_id,
        status:      input.status,
        occurred_at: occurred,
        duplicate:   r.duplicate,
      };
    },

    markShipped: async function (shipmentId, opts2) {
      _uuid(shipmentId, "shipment_id");
      opts2 = opts2 || {};
      var shippedAt = opts2.shipped_at == null ? _now() : _epochMs(opts2.shipped_at, "shipped_at");
      var eta       = _epochMs(opts2.estimated_delivery_at == null ? null : opts2.estimated_delivery_at, "estimated_delivery_at");

      var row = await _getShipmentRow(shipmentId);
      if (!row) {
        throw new TypeError("order-tracking.markShipped: shipment " + shipmentId + " not found");
      }

      await _appendEvent(shipmentId, "in-transit", "", "", shippedAt);
      var ts = _now();
      await query(
        "UPDATE shipments SET shipped_at = ?1, estimated_delivery_at = ?2, updated_at = ?3 WHERE id = ?4",
        [shippedAt, eta, ts, shipmentId],
      );
      return await this.getShipment(shipmentId);
    },

    markDelivered: async function (shipmentId, opts2) {
      _uuid(shipmentId, "shipment_id");
      opts2 = opts2 || {};
      var deliveredAt = opts2.delivered_at == null ? _now() : _epochMs(opts2.delivered_at, "delivered_at");

      var row = await _getShipmentRow(shipmentId);
      if (!row) {
        throw new TypeError("order-tracking.markDelivered: shipment " + shipmentId + " not found");
      }

      await _appendEvent(shipmentId, "delivered", "", "", deliveredAt);
      var ts = _now();
      await query(
        "UPDATE shipments SET delivered_at = ?1, updated_at = ?2 WHERE id = ?3",
        [deliveredAt, ts, shipmentId],
      );

      // Drive the parent order's FSM to `delivered` when the order
      // primitive is wired. The transition is guarded by the FSM —
      // re-firing from an already-delivered order is refused with
      // `fsm/illegal-transition`, which we swallow so a double
      // markDelivered (idempotent at the shipment layer) doesn't
      // spuriously fail at the order layer. Other refusal codes
      // surface to the caller.
      if (orderPrim) {
        try {
          await orderPrim.transition(row.order_id, "mark_delivered", {
            reason:   "shipment_delivered",
            metadata: { shipment_id: shipmentId, delivered_at: deliveredAt },
          });
        } catch (e) {
          var code = e && e.code;
          if (code !== "fsm/illegal-transition") throw e;
          // drop-silent on fsm/illegal-transition — the order is
          // already in a state where mark_delivered is a no-op
          // (delivered / refunded / cancelled).
        }
      }
      return await this.getShipment(shipmentId);
    },

    getShipment: async function (shipmentId) {
      _uuid(shipmentId, "shipment_id");
      var row = await _getShipmentRow(shipmentId);
      if (!row) return null;
      var events = (await query(
        "SELECT * FROM shipment_events WHERE shipment_id = ?1 ORDER BY occurred_at ASC, recorded_at ASC",
        [shipmentId],
      )).rows;
      row.events       = events;
      row.tracking_url = trackingUrl(row.carrier, row.tracking_number);
      return row;
    },

    listForOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      var rows = (await query(
        "SELECT * FROM shipments WHERE order_id = ?1 ORDER BY created_at ASC",
        [orderId],
      )).rows;
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].tracking_url = trackingUrl(rows[i].carrier, rows[i].tracking_number);
      }
      return rows;
    },
  };
}

module.exports = {
  create:      create,
  trackingUrl: trackingUrl,
  CARRIERS:    CARRIERS,
  STATUSES:    STATUSES,
};
