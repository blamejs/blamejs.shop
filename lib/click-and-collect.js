"use strict";
/**
 * @module shop.clickAndCollect
 * @title  Click-and-collect — buy online, pick up in store (BOPIS)
 *
 * @intro
 *   The pickup workflow has four moving pieces:
 *
 *     1. The operator publishes a set of pickup-eligible stores (each
 *        with hours, capacity, and a lead-time minimum the picker needs
 *        before a slot opens).
 *     2. At checkout the customer picks a location + a scheduled
 *        window. The schedule row lands in `scheduled` and the
 *        front-counter dashboard surfaces it.
 *     3. Once the picker has the goods on the hold shelf the operator
 *        marks the schedule `ready`. A notification fires (when a
 *        dispatcher is wired) telling the customer to come collect.
 *     4. The customer arrives, the operator captures a signature +
 *        proof-of-identity kind, the schedule lands in `picked_up`,
 *        and (when an `order` handle is wired) the parent order
 *        transitions to `delivered`.
 *
 *   A no-show path covers the customer-doesn't-arrive case:
 *   `markNoShow` records the absence + a reason; rows older than 7
 *   days in `no_show` surface through `pickupsForLocation({ status:
 *   "no_show" })` as the operator escalation queue. The primitive
 *   does NOT unilaterally refund or restock — the operator drives
 *   that via the order FSM, since BOPIS no-shows are routinely
 *   resolved by phone (the customer just got delayed).
 *
 *   FSM:
 *
 *     scheduled --markReadyForPickup--> ready --markPickedUp--> picked_up
 *           \                                  \
 *            \                                  --markNoShow--> no_show
 *             --markNoShow--> no_show  (slot lapsed without ready)
 *             --(operator)--> cancelled         (handled by reschedule path)
 *
 *   `no_show` and `picked_up` and `cancelled` are terminal. `ready`
 *   cannot regress to `scheduled` — once the goods are on the hold
 *   shelf the operator either completes the pickup or escalates.
 *
 *   Signature privacy:
 *
 *     The captured pickup signature is hashed at the boundary via
 *     `b.crypto.namespaceHash("click-and-collect-signature", raw)` and
 *     ONLY the hex digest lands in the database. The raw signature
 *     never persists — the operator can later prove a presented
 *     signature matches a stored hash without storing PII at rest.
 *     `customer_id_proof_kind` is a short label (driver_license,
 *     passport, national_id, store_credential, other) — the document
 *     number is never captured.
 *
 *   Capacity gate:
 *
 *     `scheduleAtLocation` refuses when the location's
 *     `capacity_per_hour` is already saturated for the proposed
 *     one-hour bucket containing `scheduled_window_start`. The bucket
 *     is computed as `Math.floor(scheduled_window_start / HOUR_MS)` so
 *     two slots that share the same bucket-key share a capacity pool.
 *
 *   Lead-time gate:
 *
 *     `scheduleAtLocation` refuses when `scheduled_window_start` is
 *     less than `lead_time_hours` ahead of the current monotonic
 *     clock. Operators that need to override (a same-day rush) flip
 *     the location's lead_time_hours to 0.
 *
 *   Composes:
 *     - `b.uuid.v7`            — schedule row ids (lexicographic +
 *       monotonic so ties on created_at still sort deterministically).
 *     - `b.guardUuid`          — strict UUID gate on every order_id /
 *       customer_id at the entry point.
 *     - `b.crypto.namespaceHash` — pickup signature hashing.
 *     - `order` (optional)     — when wired, `markPickedUp` drives the
 *       parent order to `delivered` via `order.transition(...,
 *       "mark_delivered")`; `customerSchedules(customer_id)` reads the
 *       customer's order ids through `order.listForCustomer(...)` so
 *       this primitive doesn't duplicate the customer→order index.
 *     - `inventoryLocations` (optional) — when wired,
 *       `availableLocations({ sku })` filters out locations where the
 *       sku has zero on-hand stock; absent, every active location is
 *       a candidate.
 *     - `notifications` (optional) — when wired,
 *       `markReadyForPickup` enqueues a customer notification (channel
 *       `pickup-ready`, event_type `pickup_ready`) keyed by the order
 *       id; absent, the FSM transition still lands but no message is
 *       sent.
 *
 * @primitive clickAndCollect
 * @related   b.uuid, b.guardUuid, b.crypto.namespaceHash, order,
 *            inventoryLocations, notifications
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var CODE_RE             = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SKU_RE              = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var POSTAL_RE           = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,15}$/;
var MAX_NAME_LEN        = 200;
var MAX_REASON_LEN      = 280;
var MAX_SIGNATURE_LEN   = 8192;
var MAX_LIST_LIMIT      = 200;
var HOUR_MS             = 3600 * 1000;
var NO_SHOW_ESCALATE_MS = 7 * 24 * 60 * 60 * 1000;
var SIGNATURE_NAMESPACE = "click-and-collect-signature";

var PICKUP_STATUSES = Object.freeze([
  "scheduled", "ready", "picked_up", "no_show", "cancelled",
]);

var PROOF_KINDS = Object.freeze([
  "driver_license", "passport", "national_id", "store_credential", "other",
]);

// ---- monotonic clock ---------------------------------------------------
//
// Operator-driven FSM transitions can land in the same millisecond on
// fast machines (markShipped immediately followed by markReadyForPickup
// in a test, for instance). Bumping by 1ms on a tie keeps the timeline
// strictly increasing so a sort-by-timestamp read returns the events in
// the order they were issued.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _orderId(s) {
  try {
    return _b().guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("click-and-collect: order_id — " + (e && e.message || "invalid UUID"));
  }
}
function _customerId(s) {
  try {
    return _b().guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("click-and-collect: customer_id — " + (e && e.message || "invalid UUID"));
  }
}
function _code(s, label) {
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("click-and-collect: " + (label || "code") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
}
function _name(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_NAME_LEN) {
    throw new TypeError("click-and-collect: name must be a non-empty string ≤ " + MAX_NAME_LEN + " chars");
  }
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("click-and-collect: " + label + " must be a positive integer");
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("click-and-collect: " + label + " must be a non-negative integer");
  }
}
function _ts(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("click-and-collect: " + label + " must be a positive integer (epoch ms)");
  }
}
function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("click-and-collect: " + label + " must be a boolean");
  }
}
function _addressObj(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    throw new TypeError("click-and-collect: address must be an object");
  }
  if (typeof a.line1 !== "string" || a.line1.length === 0 || a.line1.length > 200) {
    throw new TypeError("click-and-collect: address.line1 must be a non-empty string ≤ 200 chars");
  }
  if (typeof a.city !== "string" || a.city.length === 0 || a.city.length > 100) {
    throw new TypeError("click-and-collect: address.city must be a non-empty string ≤ 100 chars");
  }
  if (typeof a.country !== "string" || a.country.length !== 2) {
    throw new TypeError("click-and-collect: address.country must be a 2-letter ISO code");
  }
}
function _hoursObj(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) {
    throw new TypeError("click-and-collect: hours_json must be an object");
  }
  // The shape isn't enforced beyond "object" — operators may add custom
  // notes (holiday overrides, lunch breaks) per their storefront's
  // calendar. The contract is `hours_json` round-trips JSON cleanly.
  try { JSON.parse(JSON.stringify(h)); }
  catch (_e) { throw new TypeError("click-and-collect: hours_json must be JSON-serialisable"); }
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("click-and-collect: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}
function _postal(s) {
  if (typeof s !== "string" || !POSTAL_RE.test(s)) {
    throw new TypeError("click-and-collect: destination_postal must match /^[A-Za-z0-9][A-Za-z0-9 .-]{0,15}$/");
  }
}
function _reason(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_REASON_LEN) {
    throw new TypeError("click-and-collect: reason must be a non-empty string ≤ " + MAX_REASON_LEN + " chars");
  }
}
function _proofKind(s) {
  if (PROOF_KINDS.indexOf(s) === -1) {
    throw new TypeError("click-and-collect: customer_id_proof_kind must be one of " +
      PROOF_KINDS.join(", ") + ", got " + JSON.stringify(s));
  }
}
function _signature(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_SIGNATURE_LEN) {
    throw new TypeError("click-and-collect: signature must be a non-empty string ≤ " +
      MAX_SIGNATURE_LEN + " chars (base64 PNG, SVG path, or operator-defined encoding)");
  }
}
function _limit(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("click-and-collect: limit must be an integer in 1..." + MAX_LIST_LIMIT);
  }
}
function _status(s) {
  if (PICKUP_STATUSES.indexOf(s) === -1) {
    throw new TypeError("click-and-collect: status must be one of " +
      PICKUP_STATUSES.join(", ") + ", got " + JSON.stringify(s));
  }
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // order is optional — when wired, markPickedUp drives the parent
  // order FSM to delivered and customerSchedules looks up the
  // customer's order ids via order.listForCustomer. Absent both verbs
  // when the handle IS provided fails loud at boot.
  var orderPrim = opts.order || null;
  if (orderPrim) {
    if (typeof orderPrim.transition !== "function") {
      throw new TypeError("click-and-collect.create: opts.order must expose a transition(id, event, opts) method");
    }
    if (typeof orderPrim.listForCustomer !== "function") {
      throw new TypeError("click-and-collect.create: opts.order must expose a listForCustomer(customer_id, opts) method");
    }
  }

  // inventoryLocations is optional — when wired, availableLocations({
  // sku }) filters out locations where the sku has zero on-hand stock.
  var invLocations = opts.inventoryLocations || null;
  if (invLocations && typeof invLocations.stockForSku !== "function") {
    throw new TypeError("click-and-collect.create: opts.inventoryLocations must expose a stockForSku(sku) method");
  }

  // notifications is optional — when wired, markReadyForPickup
  // enqueues a customer message. Absent, the FSM transition still
  // lands; bespoke dispatchers can read from the schedules table.
  var notifications = opts.notifications || null;
  if (notifications && typeof notifications.enqueue !== "function") {
    throw new TypeError("click-and-collect.create: opts.notifications must expose an enqueue(input) method");
  }

  async function _getLocationRow(code) {
    var r = await query("SELECT * FROM pickup_locations WHERE code = ?1", [code]);
    return r.rows.length ? r.rows[0] : null;
  }

  async function _getScheduleByOrder(orderId) {
    var r = await query("SELECT * FROM pickup_schedules WHERE order_id = ?1", [orderId]);
    return r.rows.length ? r.rows[0] : null;
  }

  async function _capacityBookedForBucket(locationCode, bucketStartMs, bucketEndMs) {
    var r = await query(
      "SELECT COUNT(*) AS n FROM pickup_schedules " +
      "WHERE location_code = ?1 AND status IN ('scheduled', 'ready') " +
      "AND scheduled_window_start >= ?2 AND scheduled_window_start < ?3",
      [locationCode, bucketStartMs, bucketEndMs],
    );
    return Number(r.rows[0].n);
  }

  return {

    PICKUP_STATUSES: PICKUP_STATUSES,
    PROOF_KINDS:     PROOF_KINDS,

    // Register a pickup-eligible location. Upsert semantics on `code` —
    // re-defining the same code updates the row in place (operator
    // changes hours / capacity without invalidating prior schedules).
    definePickupLocation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("click-and-collect.definePickupLocation: input object required");
      }
      _code(input.code, "code");
      _name(input.name);
      _addressObj(input.address);
      _hoursObj(input.hours_json);
      _positiveInt(input.capacity_per_hour, "capacity_per_hour");
      _nonNegInt(input.lead_time_hours, "lead_time_hours");
      if (input.active !== undefined) _bool(input.active, "active");

      var now    = _now();
      var active = input.active === false ? 0 : 1;
      var addressJson = JSON.stringify(input.address);
      var hoursJson   = JSON.stringify(input.hours_json);

      var existing = await _getLocationRow(input.code);
      if (existing) {
        await query(
          "UPDATE pickup_locations SET name = ?1, address_json = ?2, hours_json = ?3, " +
          "capacity_per_hour = ?4, lead_time_hours = ?5, active = ?6, archived_at = NULL, " +
          "updated_at = ?7 WHERE code = ?8",
          [input.name, addressJson, hoursJson, input.capacity_per_hour,
            input.lead_time_hours, active, now, input.code],
        );
      } else {
        await query(
          "INSERT INTO pickup_locations (code, name, address_json, hours_json, " +
          "capacity_per_hour, lead_time_hours, active, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
          [input.code, input.name, addressJson, hoursJson, input.capacity_per_hour,
            input.lead_time_hours, active, now, now],
        );
      }
      return await this.getLocation(input.code);
    },

    // Hydrated read of a single location. Returns null on miss so the
    // caller can map cleanly to HTTP 404.
    getLocation: async function (code) {
      _code(code, "code");
      var row = await _getLocationRow(code);
      if (!row) return null;
      row.address = JSON.parse(row.address_json);
      row.hours   = JSON.parse(row.hours_json);
      return row;
    },

    // List active pickup-eligible locations. When `sku` is provided
    // and inventoryLocations is wired, filters to locations where the
    // sku has on-hand stock > 0. `destination_postal` is accepted for
    // shape validation but the primitive doesn't ship a geo-ranking
    // strategy itself — the column lands on the address_json and
    // operators compose a custom ranker on top.
    availableLocations: async function (listOpts) {
      listOpts = listOpts || {};
      if (listOpts.destination_postal != null) _postal(listOpts.destination_postal);
      if (listOpts.sku != null) _sku(listOpts.sku);
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      _limit(limit);

      var rows = (await query(
        "SELECT * FROM pickup_locations WHERE active = 1 AND archived_at IS NULL " +
        "ORDER BY code ASC LIMIT ?1",
        [limit],
      )).rows;

      // Filter by sku-on-hand when both the sku is requested and an
      // inventoryLocations handle is wired. Absent either, every
      // active location is a candidate (the operator's UI can still
      // render an "out of stock here" badge from a separate read).
      if (listOpts.sku && invLocations) {
        var stock = await invLocations.stockForSku(listOpts.sku);
        var stockedCodes = Object.create(null);
        var byLoc = (stock && stock.by_location) || [];
        for (var i = 0; i < byLoc.length; i += 1) {
          if (byLoc[i].quantity > 0) stockedCodes[byLoc[i].code] = true;
        }
        rows = rows.filter(function (r) { return stockedCodes[r.code]; });
      }

      // Hydrate the parsed address + hours payloads on each row so
      // the storefront's location-picker doesn't re-parse JSON
      // per-element.
      for (var k = 0; k < rows.length; k += 1) {
        rows[k].address = JSON.parse(rows[k].address_json);
        rows[k].hours   = JSON.parse(rows[k].hours_json);
      }
      return rows;
    },

    // Book a pickup window. Refuses when the location is archived /
    // inactive, when the slot is inside the location's lead_time
    // floor, when the proposed window is degenerate (end <= start),
    // or when the hour-bucket containing `scheduled_window_start` is
    // already at `capacity_per_hour`.
    scheduleAtLocation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("click-and-collect.scheduleAtLocation: input object required");
      }
      var orderId = _orderId(input.order_id);
      _code(input.location_code, "location_code");
      _ts(input.scheduled_window_start, "scheduled_window_start");
      _ts(input.scheduled_window_end,   "scheduled_window_end");
      if (input.scheduled_window_end <= input.scheduled_window_start) {
        throw new TypeError("click-and-collect.scheduleAtLocation: scheduled_window_end must be > scheduled_window_start");
      }

      var loc = await _getLocationRow(input.location_code);
      if (!loc) {
        throw new TypeError("click-and-collect.scheduleAtLocation: location_code " +
          JSON.stringify(input.location_code) + " not found");
      }
      if (!Number(loc.active) || loc.archived_at != null) {
        throw new TypeError("click-and-collect.scheduleAtLocation: location_code " +
          JSON.stringify(input.location_code) + " is not active");
      }

      var now = _now();
      var leadFloor = now + Number(loc.lead_time_hours) * HOUR_MS;
      if (input.scheduled_window_start < leadFloor) {
        throw new TypeError("click-and-collect.scheduleAtLocation: scheduled_window_start violates " +
          loc.lead_time_hours + "h lead time at " + loc.code);
      }

      // Capacity gate on the one-hour bucket containing
      // scheduled_window_start. Two slots that share the same bucket
      // share a capacity pool — operators who want a finer-grained
      // gate run a higher `capacity_per_hour` and rely on slot
      // discretisation in the storefront's window picker.
      var bucketStart = Math.floor(input.scheduled_window_start / HOUR_MS) * HOUR_MS;
      var bucketEnd   = bucketStart + HOUR_MS;
      var booked = await _capacityBookedForBucket(input.location_code, bucketStart, bucketEnd);
      // Re-scheduling the SAME order_id within the same bucket should
      // not consume an additional capacity slot — check whether an
      // existing schedule for this order already lives in the bucket
      // and exclude it from the cap.
      var existing = await _getScheduleByOrder(orderId);
      if (existing && existing.location_code === input.location_code &&
          existing.scheduled_window_start >= bucketStart &&
          existing.scheduled_window_start <  bucketEnd &&
          (existing.status === "scheduled" || existing.status === "ready")) {
        booked -= 1;
      }
      if (booked >= Number(loc.capacity_per_hour)) {
        throw new TypeError("click-and-collect.scheduleAtLocation: location_code " +
          JSON.stringify(input.location_code) + " is at capacity for the requested window");
      }

      if (existing) {
        // Re-schedule in place. Refuses to overwrite a terminal row —
        // a picked_up / no_show / cancelled order books a new pickup
        // by going through the operator's cancel + re-place flow,
        // never by mutating the original schedule.
        if (existing.status !== "scheduled" && existing.status !== "ready") {
          throw new TypeError("click-and-collect.scheduleAtLocation: order " + orderId +
            " has a terminal pickup schedule (status=" + existing.status +
            "); operator must place a new order to reschedule");
        }
        await query(
          "UPDATE pickup_schedules SET location_code = ?1, scheduled_window_start = ?2, " +
          "scheduled_window_end = ?3, status = 'scheduled', ready_at = NULL, updated_at = ?4 " +
          "WHERE order_id = ?5",
          [input.location_code, input.scheduled_window_start, input.scheduled_window_end,
            now, orderId],
        );
      } else {
        await query(
          "INSERT INTO pickup_schedules (id, order_id, location_code, " +
          "scheduled_window_start, scheduled_window_end, status, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, 'scheduled', ?6, ?7)",
          [_b().uuid.v7(), orderId, input.location_code,
            input.scheduled_window_start, input.scheduled_window_end, now, now],
        );
      }
      return await _getScheduleByOrder(orderId);
    },

    // scheduled -> ready. Stamps ready_at. When notifications is wired,
    // enqueues a `pickup_ready` message keyed by the order_id so the
    // storefront's customer-facing notification surface fires without
    // a separate operator call. Notification failures are drop-silent
    // — a notifications outage must not roll back the FSM transition
    // (the operator's hold-shelf inventory is already committed).
    markReadyForPickup: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("click-and-collect.markReadyForPickup: input object required");
      }
      var orderId = _orderId(input.order_id);
      var schedule = await _getScheduleByOrder(orderId);
      if (!schedule) {
        throw new TypeError("click-and-collect.markReadyForPickup: no pickup schedule for order " + orderId);
      }
      if (schedule.status !== "scheduled") {
        throw new TypeError("click-and-collect.markReadyForPickup: schedule is " +
          schedule.status + ", only scheduled rows can move to ready");
      }
      var readyAt = input.scheduled_for == null ? _now() : Number(input.scheduled_for);
      if (!Number.isInteger(readyAt) || readyAt <= 0) {
        throw new TypeError("click-and-collect.markReadyForPickup: scheduled_for must be a positive integer (epoch ms)");
      }
      await query(
        "UPDATE pickup_schedules SET status = 'ready', ready_at = ?1, updated_at = ?2 " +
        "WHERE order_id = ?3",
        [readyAt, _now(), orderId],
      );
      if (notifications) {
        try {
          await notifications.enqueue({
            recipient_id: orderId,
            channel:      "pickup-ready",
            event_type:   "pickup_ready",
            title:        "Your order is ready for pickup",
            body:         "",
            payload: {
              order_id:      orderId,
              location_code: schedule.location_code,
              ready_at:      readyAt,
              window_start:  schedule.scheduled_window_start,
              window_end:    schedule.scheduled_window_end,
            },
            scheduled_at: readyAt,
          });
        } catch (_e) { /* drop-silent — notifications outage must not roll back the FSM transition */ }
      }
      return await _getScheduleByOrder(orderId);
    },

    // ready -> picked_up. Captures the (namespace-hashed) signature +
    // proof-of-identity kind. When `order` is wired, drives the parent
    // order to `delivered` via `order.transition(..., "mark_delivered")`.
    markPickedUp: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("click-and-collect.markPickedUp: input object required");
      }
      var orderId = _orderId(input.order_id);
      _ts(input.picked_up_at, "picked_up_at");
      var sigHash = null;
      if (input.signature != null) {
        _signature(input.signature);
        sigHash = _b().crypto.namespaceHash(SIGNATURE_NAMESPACE, input.signature);
      }
      var proofKind = null;
      if (input.customer_id_proof_kind != null) {
        _proofKind(input.customer_id_proof_kind);
        proofKind = input.customer_id_proof_kind;
      }

      var schedule = await _getScheduleByOrder(orderId);
      if (!schedule) {
        throw new TypeError("click-and-collect.markPickedUp: no pickup schedule for order " + orderId);
      }
      if (schedule.status !== "ready") {
        throw new TypeError("click-and-collect.markPickedUp: schedule is " +
          schedule.status + ", only ready rows can move to picked_up");
      }

      var now = _now();
      await query(
        "UPDATE pickup_schedules SET status = 'picked_up', picked_up_at = ?1, " +
        "signature_hash = ?2, customer_id_proof_kind = ?3, updated_at = ?4 " +
        "WHERE order_id = ?5",
        [input.picked_up_at, sigHash, proofKind, now, orderId],
      );

      // Drive the parent order FSM to delivered. The transition is
      // guarded — an already-delivered order surfaces as
      // `fsm/illegal-transition` and we swallow it so a double
      // markPickedUp (idempotent at the schedule layer) doesn't
      // spuriously fail at the order layer. Other refusal codes
      // surface to the caller.
      if (orderPrim) {
        try {
          await orderPrim.transition(orderId, "mark_delivered", {
            reason:   "click_and_collect_picked_up",
            metadata: {
              location_code: schedule.location_code,
              picked_up_at:  input.picked_up_at,
            },
          });
        } catch (e) {
          var code = e && e.code;
          if (code !== "fsm/illegal-transition") throw e;
        }
      }
      return await _getScheduleByOrder(orderId);
    },

    // scheduled|ready -> no_show. Customer didn't arrive. Rows older
    // than 7 days in no_show surface through
    // `pickupsForLocation({ status: "no_show" })` as the operator
    // escalation queue — this primitive does NOT unilaterally refund
    // or restock; the operator drives that via the order FSM.
    markNoShow: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("click-and-collect.markNoShow: input object required");
      }
      var orderId = _orderId(input.order_id);
      _reason(input.reason);

      var schedule = await _getScheduleByOrder(orderId);
      if (!schedule) {
        throw new TypeError("click-and-collect.markNoShow: no pickup schedule for order " + orderId);
      }
      if (schedule.status !== "scheduled" && schedule.status !== "ready") {
        throw new TypeError("click-and-collect.markNoShow: schedule is " +
          schedule.status + ", only scheduled or ready rows can move to no_show");
      }
      var now = _now();
      await query(
        "UPDATE pickup_schedules SET status = 'no_show', no_show_at = ?1, updated_at = ?2 " +
        "WHERE order_id = ?3",
        [now, now, orderId],
      );
      var row = await _getScheduleByOrder(orderId);
      // Flag the escalation window inline so the caller can render the
      // operator-warning banner without re-computing the 7-day floor.
      row.escalate_after = now + NO_SHOW_ESCALATE_MS;
      row.no_show_reason = input.reason;
      return row;
    },

    // Read a hydrated schedule for an order. Returns null on miss.
    getScheduleByOrder: async function (orderId) {
      var id = _orderId(orderId);
      return await _getScheduleByOrder(id);
    },

    // Window-bounded read of schedules at a location. `from` / `to`
    // bound the scheduled_window_start column inclusively. `status`
    // is optional; absent, every status in the window matches.
    pickupsForLocation: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("click-and-collect.pickupsForLocation: opts object required");
      }
      _code(listOpts.location_code, "location_code");
      _ts(listOpts.from, "from");
      _ts(listOpts.to,   "to");
      if (listOpts.to < listOpts.from) {
        throw new TypeError("click-and-collect.pickupsForLocation: to must be >= from");
      }
      var sql, params;
      if (listOpts.status != null) {
        _status(listOpts.status);
        sql = "SELECT * FROM pickup_schedules WHERE location_code = ?1 AND status = ?2 " +
              "AND scheduled_window_start >= ?3 AND scheduled_window_start <= ?4 " +
              "ORDER BY scheduled_window_start ASC, id ASC";
        params = [listOpts.location_code, listOpts.status, listOpts.from, listOpts.to];
      } else {
        sql = "SELECT * FROM pickup_schedules WHERE location_code = ?1 " +
              "AND scheduled_window_start >= ?2 AND scheduled_window_start <= ?3 " +
              "ORDER BY scheduled_window_start ASC, id ASC";
        params = [listOpts.location_code, listOpts.from, listOpts.to];
      }
      var rows = (await query(sql, params)).rows;
      return rows;
    },

    // Schedules for a customer. Reads the customer's order ids via
    // the injected `order` primitive's `listForCustomer` — this
    // primitive does NOT duplicate the customer→order index. Refuses
    // when `order` is not wired (the customer→order linkage is the
    // order primitive's responsibility).
    customerSchedules: async function (customerId) {
      var id = _customerId(customerId);
      if (!orderPrim) {
        throw new TypeError("click-and-collect.customerSchedules: opts.order must be wired for " +
          "this read (the customer→order linkage lives on the order primitive)");
      }
      var orderPage = await orderPrim.listForCustomer(id, { limit: MAX_LIST_LIMIT });
      var orders = (orderPage && orderPage.rows) || [];
      if (!orders.length) return [];
      // SQL IN-list construction — every value is a UUID that came
      // out of the order primitive (which itself validates UUIDs at
      // write time), so the placeholder fan-out is safe. We still
      // pass them as bound params rather than interpolating.
      var placeholders = [];
      var params = [];
      for (var i = 0; i < orders.length; i += 1) {
        placeholders.push("?" + (i + 1));
        params.push(orders[i].id);
      }
      var sql = "SELECT * FROM pickup_schedules WHERE order_id IN (" +
                placeholders.join(", ") + ") ORDER BY scheduled_window_start DESC, id DESC";
      var rows = (await query(sql, params)).rows;
      return rows;
    },
  };
}

module.exports = {
  create:                  create,
  PICKUP_STATUSES:         PICKUP_STATUSES,
  PROOF_KINDS:             PROOF_KINDS,
  NO_SHOW_ESCALATE_MS:     NO_SHOW_ESCALATE_MS,
  SIGNATURE_NAMESPACE:     SIGNATURE_NAMESPACE,
};
