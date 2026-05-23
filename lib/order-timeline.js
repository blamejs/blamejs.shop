"use strict";
/**
 * @module shop.orderTimeline
 * @title  Order timeline — unified event feed across the post-checkout surface
 *
 * @intro
 *   A customer-service operator (or a customer on their order page)
 *   wants a single chronological feed of everything that happened
 *   to an order — not seven separate widgets keyed by source table.
 *   `orderTimeline` is the read-only aggregator: it queries the
 *   primitives that already own each event class and flattens the
 *   result into one `{ kind, occurred_at, title, body?, actor?,
 *   link? }` stream.
 *
 *   Sources composed (each is optional — when the corresponding
 *   peer is NOT wired into the factory, that source is skipped
 *   silently and the remaining sources still surface):
 *
 *     order             — order_transitions rows (FSM events:
 *                         mark_paid, start_fulfillment, mark_shipped,
 *                         mark_delivered, cancel, refund).
 *     orderTracking     — shipment_events rows + the shipments
 *                         themselves (label-created, in-transit,
 *                         out-for-delivery, delivered, exception,
 *                         returned).
 *     orderNotes        — order_notes rows (customer-service notes;
 *                         `customer_visible` and `internal` shapes
 *                         carry through with their visibility flag
 *                         so customerVisibleFor() can filter).
 *     returns           — return_authorizations rows (RMA requested,
 *                         approved, received, refunded, rejected).
 *     fraudScreen       — fraud_screenings rows (decision events
 *                         with score + signals). Internal-only —
 *                         never customer-visible.
 *     shippingLabels    — shipping_labels rows (label purchased,
 *                         voided, used). Operator-only.
 *     notifications     — notifications rows joined by order_id
 *                         embedded in payload_json. Customer-visible
 *                         when the channel is in-app / email and
 *                         the event_type is in the customer-safe
 *                         allowlist.
 *     payment           — accepted for API completeness; the payment
 *                         primitive is a thin Stripe wrapper with
 *                         no local ledger, so payment events surface
 *                         via the order FSM's `mark_paid` transition
 *                         and via fraudScreen's verdict. Wiring it
 *                         is a no-op today; the slot stays for
 *                         forward-compat with a future ledger.
 *
 *   Surface:
 *
 *     forOrder({ order_id, customer_visible_only? })
 *       — returns `[{ kind, occurred_at, title, body?, actor?, link? }]`
 *         newest-first. `customer_visible_only` (default false)
 *         restricts to the events a customer can see on their
 *         order page; with the flag off, every event surfaces for
 *         the operator console.
 *
 *     summarize(order_id)
 *       — returns `{ status, first_event_at, last_event_at,
 *         event_count, milestones: { paid_at?, fulfilled_at?,
 *         shipped_at?, delivered_at?, refunded_at? } }`. Reads
 *         through the cache when fresh; recomputes from sources
 *         and refreshes the cache when not.
 *
 *     customerVisibleFor(order_id, { locale })
 *       — same shape as `forOrder({ customer_visible_only: true })`
 *         with per-event titles overridden by the per-locale title
 *         map. Locale must be BCP-47 (`en`, `en-US`, `de-CH`, etc.);
 *         a locale with no override falls back to the canonical
 *         English title.
 *
 *     compareOrders([order_id_a, order_id_b])
 *       — operator-debugging side-by-side view. Returns
 *         `{ a: { order_id, timeline }, b: { order_id, timeline } }`
 *         where each timeline is the operator-facing forOrder
 *         shape (no customer_visible_only).
 *
 *     recentActivity({ limit, customer_id? })
 *       — flattened cross-order feed for the operator dashboard.
 *         Returns up to `limit` (1..100) events newest-first across
 *         every order touched in the window. When `customer_id` is
 *         provided, scopes to that customer's orders.
 *
 *   Read-only:
 *     This primitive WRITES exactly one table: `order_timeline_cache`,
 *     and only as a memoization side-effect of summarize() /
 *     recentActivity(). Every event row lives in its source
 *     primitive's table — orderTimeline never inserts or mutates
 *     order_transitions / shipment_events / order_notes / etc.
 *
 *   Composition (b.* primitives in use):
 *     - b.guardUuid  — every order_id input passes through the
 *                      strict profile so a hostile cursor can't
 *                      smuggle SQL fragments through.
 *     - b.uuid.v7    — cache row primary key.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var MAX_RECENT_LIMIT     = 100;
var DEFAULT_RECENT_LIMIT = 20;

// Cache freshness window. summarize() returns the cached row when
// computed_at is within this window AND no source has a newer
// event than last_event_at. The window is a hard upper bound so a
// pathological "no new events but the cache is stale" case still
// recomputes after a few minutes — gives the operator dashboard
// fresh totals even when the underlying primitives are quiet.
var CACHE_TTL_MS = 5 * 60 * 1000;

// BCP-47 shape: 2-3 alpha primary subtag, optional region/script
// subtags. Matches the shape gift-options uses for the same purpose.
var BCP47_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// Notification event-types the customer is permitted to see on
// their own order page. Other notification kinds (operator-only
// admin alerts, fraud-team handoffs) are filtered out of the
// customer feed even when their payload references the order.
var CUSTOMER_NOTIFICATION_EVENTS = {
  "order.confirmed":     true,
  "order.shipped":       true,
  "order.delivered":     true,
  "order.refunded":      true,
  "shipment.update":     true,
  "return.approved":     true,
  "return.received":     true,
  "return.refunded":     true,
  "payment.receipt":     true,
};

// Order-FSM events → canonical English titles. Events not in this
// map fall through with `on_event` as the title.
var ORDER_EVENT_TITLES = {
  "create":            "Order placed",
  "mark_paid":         "Payment received",
  "start_fulfillment": "Preparing for shipment",
  "mark_shipped":      "Order shipped",
  "mark_delivered":    "Order delivered",
  "cancel":            "Order cancelled",
  "refund":            "Order refunded",
};

// Shipment-event statuses → customer-readable titles.
var SHIPMENT_STATUS_TITLES = {
  "pending":          "Shipment created",
  "label-created":    "Shipping label printed",
  "in-transit":       "In transit",
  "out-for-delivery": "Out for delivery",
  "delivered":        "Delivered",
  "exception":        "Delivery exception",
  "returned":         "Returned to sender",
};

// Order-FSM events that the customer sees on their order page.
// Internal mid-fulfillment events (`start_fulfillment`) stay
// operator-only — the customer sees "shipped" when the parcel
// actually ships, not when the warehouse picks it.
var CUSTOMER_VISIBLE_ORDER_EVENTS = {
  "create":         true,
  "mark_paid":      true,
  "mark_shipped":   true,
  "mark_delivered": true,
  "cancel":         true,
  "refund":         true,
};

// Shipment-event statuses the customer sees.
var CUSTOMER_VISIBLE_SHIPMENT_STATUSES = {
  "label-created":    true,
  "in-transit":       true,
  "out-for-delivery": true,
  "delivered":        true,
  "exception":        true,
  "returned":         true,
};

// Per-locale title overrides. Only a small set is shipped inline
// — the framework's i18n primitive is the place to register
// fuller catalogs; operators that need more locales can wrap this
// primitive and substitute their own table.
var LOCALE_TITLES = {
  "en": {
    "order.create":            "Order placed",
    "order.mark_paid":         "Payment received",
    "order.mark_shipped":      "Order shipped",
    "order.mark_delivered":    "Order delivered",
    "order.cancel":            "Order cancelled",
    "order.refund":            "Order refunded",
    "shipment.label-created":  "Shipping label printed",
    "shipment.in-transit":     "In transit",
    "shipment.out-for-delivery": "Out for delivery",
    "shipment.delivered":      "Delivered",
    "shipment.exception":      "Delivery exception",
    "shipment.returned":       "Returned to sender",
    "return.requested":        "Return requested",
    "return.approved":         "Return approved",
    "return.received":         "Return received",
    "return.refunded":         "Refund issued",
    "return.rejected":         "Return rejected",
    "note":                    "Note from support",
  },
  "es": {
    "order.create":            "Pedido realizado",
    "order.mark_paid":         "Pago recibido",
    "order.mark_shipped":      "Pedido enviado",
    "order.mark_delivered":    "Pedido entregado",
    "order.cancel":            "Pedido cancelado",
    "order.refund":            "Pedido reembolsado",
    "shipment.label-created":  "Etiqueta de envio impresa",
    "shipment.in-transit":     "En transito",
    "shipment.out-for-delivery": "En reparto",
    "shipment.delivered":      "Entregado",
    "shipment.exception":      "Excepcion de entrega",
    "shipment.returned":       "Devuelto al remitente",
    "return.requested":        "Devolucion solicitada",
    "return.approved":         "Devolucion aprobada",
    "return.received":         "Devolucion recibida",
    "return.refunded":         "Reembolso emitido",
    "return.rejected":         "Devolucion rechazada",
    "note":                    "Nota de soporte",
  },
  "de": {
    "order.create":            "Bestellung aufgegeben",
    "order.mark_paid":         "Zahlung erhalten",
    "order.mark_shipped":      "Bestellung versandt",
    "order.mark_delivered":    "Bestellung zugestellt",
    "order.cancel":            "Bestellung storniert",
    "order.refund":            "Bestellung erstattet",
    "shipment.label-created":  "Versandetikett gedruckt",
    "shipment.in-transit":     "Unterwegs",
    "shipment.out-for-delivery": "In Zustellung",
    "shipment.delivered":      "Zugestellt",
    "shipment.exception":      "Zustellungsproblem",
    "shipment.returned":       "An Absender retourniert",
    "return.requested":        "Ruecksendung angefragt",
    "return.approved":         "Ruecksendung genehmigt",
    "return.received":         "Ruecksendung erhalten",
    "return.refunded":         "Rueckerstattung ausgestellt",
    "return.rejected":         "Ruecksendung abgelehnt",
    "note":                    "Hinweis vom Support",
  },
};

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("orderTimeline: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _bool(v, label) {
  if (v == null) return false;
  if (typeof v !== "boolean") {
    throw new TypeError("orderTimeline: " + label + " must be a boolean when provided");
  }
  return v;
}

function _limit(n, max, def) {
  if (n == null) return def;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TypeError("orderTimeline: limit must be an integer 1..." + max);
  }
  return n;
}

function _locale(s) {
  if (typeof s !== "string" || !BCP47_RE.test(s)) {
    throw new TypeError("orderTimeline: locale must be a BCP-47-shape string (e.g. 'en-US')");
  }
  return s;
}

function _now() { return Date.now(); }

// Resolve a locale string against the catalog. Tries the full tag
// ("en-US"), then the primary subtag ("en"), then falls back to
// "en". Keeps the surface tolerant of region tags the catalog
// doesn't explicitly enumerate.
function _resolveLocale(locale) {
  var lc = locale.toLowerCase();
  if (LOCALE_TITLES[lc]) return LOCALE_TITLES[lc];
  var primary = lc.split("-")[0];
  if (LOCALE_TITLES[primary]) return LOCALE_TITLES[primary];
  return LOCALE_TITLES.en;
}

function _titleForKey(catalog, key, fallback) {
  if (catalog && catalog[key]) return catalog[key];
  return fallback;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Accept (but do not actively use) the payment peer — the
  // payment primitive is a thin Stripe wrapper with no local
  // ledger queryable by order_id. Payment milestones surface
  // through the order FSM (mark_paid → order_transitions) and
  // through fraudScreen verdicts. The slot stays for forward-
  // compat when a payment-side event ledger lands.
  var payment        = opts.payment        || null;
  if (payment) { /* reserved — see header */ }
  var orderPrim      = opts.order          || null;
  var orderTracking  = opts.orderTracking  || null;
  var orderNotes     = opts.orderNotes     || null;
  var returnsPrim    = opts.returns        || null;
  var fraudScreen    = opts.fraudScreen    || null;
  var shippingLabels = opts.shippingLabels || null;
  var notifications  = opts.notifications  || null;

  // ---- per-source collectors --------------------------------------------
  //
  // Each collector returns an array of `{ kind, occurred_at, title,
  // body?, actor?, link?, customer_visible }` records. Missing peers
  // collapse to an empty list so the aggregator stays the same shape
  // regardless of wiring. Source ownership: each collector queries
  // its own source primitive's table — orderTimeline never invents
  // SQL against a table whose owning primitive isn't wired in.

  async function _collectOrderEvents(orderId) {
    if (!orderPrim) return [];
    var rows = (await query(
      "SELECT id, from_state, to_state, on_event, reason, metadata_json, occurred_at " +
      "FROM order_transitions WHERE order_id = ?1 ORDER BY occurred_at ASC",
      [orderId],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      var title = ORDER_EVENT_TITLES[r.on_event] || r.on_event;
      var meta;
      try { meta = JSON.parse(r.metadata_json || "{}"); }
      catch (_e) { meta = {}; }                                              // drop-silent — bad JSON falls through to empty
      var body = r.reason
        ? r.reason
        : (r.from_state + " → " + r.to_state);
      out.push({
        kind:              "order." + r.on_event,
        occurred_at:       Number(r.occurred_at),
        title:             title,
        body:              body,
        actor:             "system",
        link:              null,
        customer_visible:  CUSTOMER_VISIBLE_ORDER_EVENTS[r.on_event] === true,
        _localeKey:        "order." + r.on_event,
        _metadata:         meta,
      });
    }
    return out;
  }

  async function _collectShipmentEvents(orderId) {
    if (!orderTracking) return [];
    // Pull the shipments owned by this order, then their events
    // in one pass. Two trips total — keeps the per-row composition
    // simple and matches orderTracking's own listForOrder shape.
    var shipments = await orderTracking.listForOrder(orderId);
    var out = [];
    for (var s = 0; s < shipments.length; s += 1) {
      var sh = shipments[s];
      var evRows = (await query(
        "SELECT id, status, location, detail, occurred_at " +
        "FROM shipment_events WHERE shipment_id = ?1 ORDER BY occurred_at ASC",
        [sh.id],
      )).rows;
      for (var i = 0; i < evRows.length; i += 1) {
        var e = evRows[i];
        var title = SHIPMENT_STATUS_TITLES[e.status] || e.status;
        var parts = [];
        if (e.location) parts.push(e.location);
        if (e.detail)   parts.push(e.detail);
        out.push({
          kind:              "shipment." + e.status,
          occurred_at:       Number(e.occurred_at),
          title:             title,
          body:              parts.length ? parts.join(" — ") : null,
          actor:             "carrier",
          link:              sh.tracking_url || null,
          customer_visible:  CUSTOMER_VISIBLE_SHIPMENT_STATUSES[e.status] === true,
          _localeKey:        "shipment." + e.status,
          _metadata: {
            shipment_id:     sh.id,
            carrier:         sh.carrier,
            tracking_number: sh.tracking_number || null,
          },
        });
      }
    }
    return out;
  }

  async function _collectNotes(orderId) {
    if (!orderNotes) return [];
    var rows = (await query(
      "SELECT id, parent_note_id, author, author_id, visibility, body, " +
      "created_at FROM order_notes WHERE order_id = ?1 ORDER BY created_at ASC",
      [orderId],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var n = rows[i];
      out.push({
        kind:              "note." + n.visibility,
        occurred_at:       Number(n.created_at),
        title:             n.visibility === "customer_visible"
                             ? "Note from support"
                             : "Internal note",
        body:              n.body,
        actor:             n.author,
        link:              null,
        customer_visible:  n.visibility === "customer_visible",
        _localeKey:        "note",
        _metadata: {
          note_id:        n.id,
          parent_note_id: n.parent_note_id || null,
          visibility:     n.visibility,
        },
      });
    }
    return out;
  }

  async function _collectReturns(orderId) {
    if (!returnsPrim) return [];
    var rows = (await query(
      "SELECT id, rma_code, status, reason, customer_notes, operator_notes, " +
      "approved_at, received_at, refunded_at, rejected_at, rejected_reason, " +
      "created_at FROM return_authorizations WHERE order_id = ?1 " +
      "ORDER BY created_at ASC",
      [orderId],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      // Every RMA contributes a 'requested' event at created_at,
      // plus one per terminal/intermediate timestamp present.
      out.push({
        kind:              "return.requested",
        occurred_at:       Number(r.created_at),
        title:             "Return requested",
        body:              r.rma_code + " — " + r.reason,
        actor:             "customer",
        link:              null,
        customer_visible:  true,
        _localeKey:        "return.requested",
        _metadata:         { rma_id: r.id, rma_code: r.rma_code, status: r.status },
      });
      if (r.approved_at) {
        out.push({
          kind:              "return.approved",
          occurred_at:       Number(r.approved_at),
          title:             "Return approved",
          body:              r.rma_code,
          actor:             "operator",
          link:              null,
          customer_visible:  true,
          _localeKey:        "return.approved",
          _metadata:         { rma_id: r.id, rma_code: r.rma_code },
        });
      }
      if (r.received_at) {
        out.push({
          kind:              "return.received",
          occurred_at:       Number(r.received_at),
          title:             "Return received",
          body:              r.rma_code,
          actor:             "operator",
          link:              null,
          customer_visible:  true,
          _localeKey:        "return.received",
          _metadata:         { rma_id: r.id, rma_code: r.rma_code },
        });
      }
      if (r.refunded_at) {
        out.push({
          kind:              "return.refunded",
          occurred_at:       Number(r.refunded_at),
          title:             "Refund issued",
          body:              r.rma_code,
          actor:             "operator",
          link:              null,
          customer_visible:  true,
          _localeKey:        "return.refunded",
          _metadata:         { rma_id: r.id, rma_code: r.rma_code },
        });
      }
      if (r.rejected_at) {
        out.push({
          kind:              "return.rejected",
          occurred_at:       Number(r.rejected_at),
          title:             "Return rejected",
          body:              r.rejected_reason || r.rma_code,
          actor:             "operator",
          link:              null,
          customer_visible:  true,
          _localeKey:        "return.rejected",
          _metadata:         { rma_id: r.id, rma_code: r.rma_code },
        });
      }
    }
    return out;
  }

  async function _collectFraudScreenings(orderId) {
    if (!fraudScreen) return [];
    var rows = (await query(
      "SELECT id, score, decision, signals_json, actual_outcome, occurred_at " +
      "FROM fraud_screenings WHERE order_id = ?1 ORDER BY occurred_at ASC",
      [orderId],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      out.push({
        kind:              "fraud.decision",
        occurred_at:       Number(r.occurred_at),
        title:             "Fraud screen: " + r.decision,
        body:              "Score " + r.score + (r.actual_outcome ? " — outcome " + r.actual_outcome : ""),
        actor:             "system",
        link:              null,
        customer_visible:  false,
        _localeKey:        "fraud.decision",
        _metadata: {
          screening_id:    r.id,
          score:           r.score,
          decision:        r.decision,
          actual_outcome:  r.actual_outcome || null,
        },
      });
    }
    return out;
  }

  async function _collectShippingLabels(orderId) {
    if (!shippingLabels) return [];
    // Labels are owned per-shipment; join through shipments to
    // reach the labels for this order. Query the table directly
    // because the shippingLabels primitive surface is still pending
    // — the table exists at migration 0051 and is the canonical
    // source. When the primitive lands, this collector switches to
    // calling its listForOrder(orderId) instead.
    var rows = (await query(
      "SELECT sl.id, sl.carrier, sl.tracking_number, sl.service_level, " +
      "sl.status, sl.cost_minor, sl.currency, sl.purchased_via, " +
      "sl.created_at, sl.purchased_at, sl.voided_at, sl.used_at " +
      "FROM shipping_labels sl " +
      "JOIN shipments s ON s.id = sl.shipment_id " +
      "WHERE s.order_id = ?1 " +
      "ORDER BY sl.created_at ASC",
      [orderId],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var l = rows[i];
      out.push({
        kind:              "label.requested",
        occurred_at:       Number(l.created_at),
        title:             "Shipping label requested",
        body:              l.carrier + " · " + l.service_level,
        actor:             "operator",
        link:              null,
        customer_visible:  false,
        _localeKey:        "label.requested",
        _metadata: {
          label_id:        l.id,
          carrier:         l.carrier,
          purchased_via:   l.purchased_via || null,
        },
      });
      if (l.purchased_at) {
        out.push({
          kind:              "label.purchased",
          occurred_at:       Number(l.purchased_at),
          title:             "Shipping label purchased",
          body:              l.carrier + (l.cost_minor != null ? " · " + l.cost_minor + " " + (l.currency || "") : ""),
          actor:             "operator",
          link:              null,
          customer_visible:  false,
          _localeKey:        "label.purchased",
          _metadata:         { label_id: l.id, carrier: l.carrier },
        });
      }
      if (l.voided_at) {
        out.push({
          kind:              "label.voided",
          occurred_at:       Number(l.voided_at),
          title:             "Shipping label voided",
          body:              l.carrier,
          actor:             "operator",
          link:              null,
          customer_visible:  false,
          _localeKey:        "label.voided",
          _metadata:         { label_id: l.id, carrier: l.carrier },
        });
      }
      if (l.used_at) {
        out.push({
          kind:              "label.used",
          occurred_at:       Number(l.used_at),
          title:             "Shipping label handed to carrier",
          body:              l.carrier,
          actor:             "operator",
          link:              null,
          customer_visible:  false,
          _localeKey:        "label.used",
          _metadata:         { label_id: l.id, carrier: l.carrier },
        });
      }
    }
    return out;
  }

  async function _collectNotifications(orderId) {
    if (!notifications) return [];
    // notifications has no order_id column — the link is via
    // payload_json. Cheap LIKE filter on the JSON blob: the
    // dispatcher writes `"order_id":"<uuid>"` into payload when
    // the notification relates to an order. Best-effort: a
    // notification payload that uses a different key shape won't
    // surface here, which the operator handles by wrapping their
    // dispatcher to also call this primitive's add-side surface
    // when that exists.
    var needle = '"order_id":"' + orderId + '"';
    var rows = (await query(
      "SELECT id, channel, event_type, title, body, status, scheduled_at, " +
      "sent_at, read_at, created_at FROM notifications " +
      "WHERE payload_json LIKE ?1 ORDER BY created_at ASC",
      ["%" + needle + "%"],
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var n = rows[i];
      var when = Number(n.sent_at || n.created_at);
      var visible = CUSTOMER_NOTIFICATION_EVENTS[n.event_type] === true
                    && (n.channel === "in-app" || n.channel === "email");
      out.push({
        kind:              "notification." + n.event_type,
        occurred_at:       when,
        title:             n.title || n.event_type,
        body:              n.body || null,
        actor:             "system",
        link:              null,
        customer_visible:  visible,
        _localeKey:        "notification." + n.event_type,
        _metadata: {
          notification_id: n.id,
          channel:         n.channel,
          status:          n.status,
        },
      });
    }
    return out;
  }

  // ---- aggregation ------------------------------------------------------

  async function _collectAll(orderId) {
    var batches = await Promise.all([
      _collectOrderEvents(orderId),
      _collectShipmentEvents(orderId),
      _collectNotes(orderId),
      _collectReturns(orderId),
      _collectFraudScreenings(orderId),
      _collectShippingLabels(orderId),
      _collectNotifications(orderId),
    ]);
    var flat = [];
    for (var b = 0; b < batches.length; b += 1) {
      for (var i = 0; i < batches[b].length; i += 1) {
        flat.push(batches[b][i]);
      }
    }
    return flat;
  }

  function _sortNewestFirst(events) {
    events.sort(function (a, b) {
      if (b.occurred_at !== a.occurred_at) return b.occurred_at - a.occurred_at;
      // Tie-break on kind so the order is deterministic across
      // platforms. The choice of kind ordering is arbitrary but
      // stable; tests that compare consecutive same-ms events can
      // rely on it.
      if (a.kind < b.kind) return 1;
      if (a.kind > b.kind) return -1;
      return 0;
    });
    return events;
  }

  function _stripInternalFields(events) {
    var out = [];
    for (var i = 0; i < events.length; i += 1) {
      var e = events[i];
      out.push({
        kind:        e.kind,
        occurred_at: e.occurred_at,
        title:       e.title,
        body:        e.body == null ? null : e.body,
        actor:       e.actor || null,
        link:        e.link  || null,
      });
    }
    return out;
  }

  function _extractMilestones(events) {
    var m = {};
    for (var i = 0; i < events.length; i += 1) {
      var e = events[i];
      if (e.kind === "order.mark_paid"      && m.paid_at      == null) m.paid_at      = e.occurred_at;
      if (e.kind === "order.start_fulfillment" && m.fulfilled_at == null) m.fulfilled_at = e.occurred_at;
      if (e.kind === "order.mark_shipped"   && m.shipped_at   == null) m.shipped_at   = e.occurred_at;
      if (e.kind === "order.mark_delivered" && m.delivered_at == null) m.delivered_at = e.occurred_at;
      if (e.kind === "order.refund"         && m.refunded_at  == null) m.refunded_at  = e.occurred_at;
    }
    return m;
  }

  async function _readOrderStatus(orderId) {
    if (!orderPrim) return null;
    var r = await query("SELECT status FROM orders WHERE id = ?1", [orderId]);
    return r.rows.length ? r.rows[0].status : null;
  }

  async function _cacheGet(orderId) {
    var r = await query(
      "SELECT order_id, event_count, last_event_at, milestones_json, computed_at " +
      "FROM order_timeline_cache WHERE order_id = ?1",
      [orderId],
    );
    return r.rows[0] || null;
  }

  async function _cachePut(orderId, summary) {
    var ts = _now();
    // INSERT-or-REPLACE on the PK keeps the row count stable. SQLite's
    // INSERT OR REPLACE is the cross-dialect-compatible upsert shape
    // — same approach sales-report-cache uses (DELETE + INSERT) for
    // engines that lack ON CONFLICT.
    var blob = Object.assign({}, summary.milestones || {});
    // _source_row_count is the freshness-bookkeeping field —
    // underscored so the public milestones object returned by
    // summarize() never carries it.
    if (typeof summary.source_row_count === "number") {
      blob._source_row_count = summary.source_row_count;
    }
    await query("DELETE FROM order_timeline_cache WHERE order_id = ?1", [orderId]);
    await query(
      "INSERT INTO order_timeline_cache " +
      "(order_id, event_count, last_event_at, milestones_json, computed_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [
        orderId,
        summary.event_count,
        summary.last_event_at || 0,
        JSON.stringify(blob),
        ts,
      ],
    );
  }

  // The cache is fresh when computed_at is within CACHE_TTL_MS AND
  // no source has a newer event than last_event_at AND the per-
  // source row counts match what the cache row recorded. The "no
  // newer event" check alone isn't sufficient — two events landing
  // in the same epoch-ms (common on a fast in-memory test runner or
  // when an automation fans events out in a tight loop) would slip
  // past a max-only comparison. The per-source row count closes
  // that gap: if a source has more rows than the cache last saw,
  // the cache is stale even when the timestamps tie.
  //
  // The recorded source-row-count lives in the cache's
  // milestones_json blob under the `_source_row_count` key so the
  // schema migration didn't need a second column dedicated to
  // freshness bookkeeping.
  async function _cacheIsFresh(cacheRow, nowTs) {
    if (!cacheRow) return false;
    if (nowTs - Number(cacheRow.computed_at) > CACHE_TTL_MS) return false;
    var orderId = cacheRow.order_id;
    var stats = await _sourceStats(orderId);
    if (stats.latest > Number(cacheRow.last_event_at)) return false;
    var recordedCount = null;
    try {
      var blob = JSON.parse(cacheRow.milestones_json || "{}");
      if (typeof blob._source_row_count === "number") recordedCount = blob._source_row_count;
    } catch (_e) { recordedCount = null; }                                   // drop-silent — unparseable cache forces a refresh
    if (recordedCount == null) return false;
    if (stats.totalCount !== recordedCount) return false;
    return true;
  }

  // Roll up the per-source freshness stats. Returns `{ latest,
  // totalCount }` — the maximum timestamp across every wired
  // source and the total row count those sources contribute to
  // this order. Used by both the cache freshness check and the
  // cache-store path so the row count written into the cache row
  // matches the count used to invalidate it.
  async function _sourceStats(orderId) {
    var checks = [];
    if (orderPrim) {
      checks.push(query(
        "SELECT MAX(occurred_at) AS m, COUNT(*) AS n FROM order_transitions WHERE order_id = ?1",
        [orderId],
      ));
    }
    if (orderTracking) {
      checks.push(query(
        "SELECT MAX(se.occurred_at) AS m, COUNT(*) AS n FROM shipment_events se " +
        "JOIN shipments s ON s.id = se.shipment_id WHERE s.order_id = ?1",
        [orderId],
      ));
    }
    if (orderNotes) {
      checks.push(query(
        "SELECT MAX(created_at) AS m, COUNT(*) AS n FROM order_notes WHERE order_id = ?1",
        [orderId],
      ));
    }
    if (returnsPrim) {
      checks.push(query(
        "SELECT " +
        "(SELECT MAX(created_at)  FROM return_authorizations WHERE order_id = ?1) AS c1, " +
        "(SELECT MAX(approved_at) FROM return_authorizations WHERE order_id = ?1) AS c2, " +
        "(SELECT MAX(received_at) FROM return_authorizations WHERE order_id = ?1) AS c3, " +
        "(SELECT MAX(refunded_at) FROM return_authorizations WHERE order_id = ?1) AS c4, " +
        "(SELECT MAX(rejected_at) FROM return_authorizations WHERE order_id = ?1) AS c5, " +
        "(SELECT COUNT(*) FROM return_authorizations WHERE order_id = ?1) AS n",
        [orderId],
      ));
    }
    if (fraudScreen) {
      checks.push(query(
        "SELECT MAX(occurred_at) AS m, COUNT(*) AS n FROM fraud_screenings WHERE order_id = ?1",
        [orderId],
      ));
    }
    if (shippingLabels) {
      checks.push(query(
        "SELECT MAX(sl.purchased_at) AS m, COUNT(*) AS n FROM shipping_labels sl " +
        "JOIN shipments s ON s.id = sl.shipment_id WHERE s.order_id = ?1",
        [orderId],
      ));
    }
    if (notifications) {
      checks.push(query(
        "SELECT MAX(created_at) AS m, COUNT(*) AS n FROM notifications " +
        "WHERE payload_json LIKE '%\"order_id\":\"' || ?1 || '\"%'",
        [orderId],
      ));
    }
    var results = await Promise.all(checks);
    var latest = 0;
    var totalCount = 0;
    for (var i = 0; i < results.length; i += 1) {
      var rows = results[i].rows;
      if (!rows.length) continue;
      var row = rows[0];
      var keys = Object.keys(row);
      for (var k = 0; k < keys.length; k += 1) {
        var key = keys[k];
        var raw = row[key];
        if (raw == null) continue;
        if (key === "n") {
          totalCount += Number(raw) || 0;
          continue;
        }
        var v = Number(raw);
        if (Number.isFinite(v) && v > latest) latest = v;
      }
    }
    return { latest: latest, totalCount: totalCount };
  }

  // ---- public surface ---------------------------------------------------

  return {
    CACHE_TTL_MS:             CACHE_TTL_MS,
    MAX_RECENT_LIMIT:         MAX_RECENT_LIMIT,
    DEFAULT_RECENT_LIMIT:     DEFAULT_RECENT_LIMIT,

    forOrder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("orderTimeline.forOrder: input object required");
      }
      var orderId = _uuid(input.order_id, "order_id");
      var visibleOnly = _bool(input.customer_visible_only, "customer_visible_only");

      var events = await _collectAll(orderId);
      if (visibleOnly) {
        events = events.filter(function (e) { return e.customer_visible === true; });
      }
      _sortNewestFirst(events);
      return _stripInternalFields(events);
    },

    summarize: async function (orderId) {
      orderId = _uuid(orderId, "order_id");
      var nowTs = _now();
      var cached = await _cacheGet(orderId);
      if (await _cacheIsFresh(cached, nowTs)) {
        var milestones = {};
        try { milestones = JSON.parse(cached.milestones_json || "{}"); }
        catch (_e) { milestones = {}; }                                       // drop-silent — bad cache JSON falls through to fresh fields
        // Strip the underscored bookkeeping key so the public
        // milestones object stays clean.
        if (milestones && Object.prototype.hasOwnProperty.call(milestones, "_source_row_count")) {
          delete milestones._source_row_count;
        }
        return {
          status:          await _readOrderStatus(orderId),
          first_event_at:  null, // not stored in cache; recompute by walking sources
          last_event_at:   Number(cached.last_event_at) || null,
          event_count:     Number(cached.event_count) || 0,
          milestones:      milestones,
          cache_hit:       true,
        };
      }
      var events = await _collectAll(orderId);
      _sortNewestFirst(events);
      var first = events.length ? events[events.length - 1].occurred_at : null;
      var last  = events.length ? events[0].occurred_at : null;
      var miles = _extractMilestones(events);
      var stats = await _sourceStats(orderId);
      var summary = {
        status:          await _readOrderStatus(orderId),
        first_event_at:  first,
        last_event_at:   last,
        event_count:     events.length,
        milestones:      miles,
        cache_hit:       false,
      };
      await _cachePut(orderId, {
        event_count:      events.length,
        last_event_at:    last || 0,
        milestones:       miles,
        source_row_count: stats.totalCount,
      });
      return summary;
    },

    customerVisibleFor: async function (orderId, lopts) {
      orderId = _uuid(orderId, "order_id");
      if (!lopts || typeof lopts !== "object") {
        throw new TypeError("orderTimeline.customerVisibleFor: options object required");
      }
      var locale = _locale(lopts.locale);
      var catalog = _resolveLocale(locale);

      var events = await _collectAll(orderId);
      events = events.filter(function (e) { return e.customer_visible === true; });
      _sortNewestFirst(events);
      // Per-locale title swap before stripping internal fields. The
      // locale catalog is keyed by `_localeKey`; absent entries fall
      // back to the canonical English title already on the event.
      for (var i = 0; i < events.length; i += 1) {
        events[i].title = _titleForKey(catalog, events[i]._localeKey, events[i].title);
      }
      var stripped = _stripInternalFields(events);
      return { locale: locale, events: stripped };
    },

    compareOrders: async function (orderIds) {
      if (!Array.isArray(orderIds) || orderIds.length !== 2) {
        throw new TypeError("orderTimeline.compareOrders: orderIds must be a 2-element array");
      }
      var a = _uuid(orderIds[0], "orderIds[0]");
      var b = _uuid(orderIds[1], "orderIds[1]");
      var batches = await Promise.all([
        _collectAll(a),
        _collectAll(b),
      ]);
      _sortNewestFirst(batches[0]);
      _sortNewestFirst(batches[1]);
      return {
        a: { order_id: a, timeline: _stripInternalFields(batches[0]) },
        b: { order_id: b, timeline: _stripInternalFields(batches[1]) },
      };
    },

    recentActivity: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("orderTimeline.recentActivity: options object required");
      }
      var limit = _limit(listOpts.limit, MAX_RECENT_LIMIT, DEFAULT_RECENT_LIMIT);
      var customerId = null;
      if (listOpts.customer_id != null) {
        customerId = _uuid(listOpts.customer_id, "customer_id");
      }

      // Scope: pull the most recently touched orders, then collect
      // their timelines and merge. The cache's last_event_at index
      // drives the scope query — cheap, even when the orders table
      // is large.
      var scopeSql, scopeParams;
      if (customerId) {
        scopeSql = "SELECT o.id, c.last_event_at FROM orders o " +
                   "LEFT JOIN order_timeline_cache c ON c.order_id = o.id " +
                   "WHERE o.customer_id = ?1 " +
                   "ORDER BY COALESCE(c.last_event_at, o.updated_at) DESC " +
                   "LIMIT ?2";
        scopeParams = [customerId, limit];
      } else {
        scopeSql = "SELECT o.id, c.last_event_at FROM orders o " +
                   "LEFT JOIN order_timeline_cache c ON c.order_id = o.id " +
                   "ORDER BY COALESCE(c.last_event_at, o.updated_at) DESC " +
                   "LIMIT ?1";
        scopeParams = [limit];
      }
      var scopeRows = (await query(scopeSql, scopeParams)).rows;

      var merged = [];
      for (var i = 0; i < scopeRows.length; i += 1) {
        var oid = scopeRows[i].id;
        var ev = await _collectAll(oid);
        for (var j = 0; j < ev.length; j += 1) {
          var rec = ev[j];
          merged.push({
            order_id:    oid,
            kind:        rec.kind,
            occurred_at: rec.occurred_at,
            title:       rec.title,
            body:        rec.body == null ? null : rec.body,
            actor:       rec.actor || null,
            link:        rec.link  || null,
          });
        }
      }
      merged.sort(function (x, y) {
        if (y.occurred_at !== x.occurred_at) return y.occurred_at - x.occurred_at;
        if (x.kind < y.kind) return 1;
        if (x.kind > y.kind) return -1;
        return 0;
      });
      if (merged.length > limit) merged.length = limit;
      return merged;
    },

    // Operator-facing cache sweep. Removes rows whose `computed_at`
    // is older than the TTL — useful as a daily cron when the
    // dashboard hasn't refreshed an order in days.
    purgeStaleCache: async function (olderThanMs) {
      var bound = Number.isInteger(olderThanMs) && olderThanMs > 0
        ? olderThanMs
        : CACHE_TTL_MS * 12;
      var cutoff = _now() - bound;
      var r = await query(
        "DELETE FROM order_timeline_cache WHERE computed_at < ?1",
        [cutoff],
      );
      return { purged: Number(r.rowCount || 0) };
    },
  };
}

module.exports = {
  create:               create,
  CACHE_TTL_MS:         CACHE_TTL_MS,
  MAX_RECENT_LIMIT:     MAX_RECENT_LIMIT,
  DEFAULT_RECENT_LIMIT: DEFAULT_RECENT_LIMIT,
};
