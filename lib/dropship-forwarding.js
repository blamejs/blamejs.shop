"use strict";
/**
 * @module shop.dropshipForwarding
 * @title  Dropship forwarding — general-purpose drop-ship vendor
 *         binding + per-order forward-to-vendor record
 *
 * @intro
 *   Operators selling drop-shipped goods (no inventory on hand;
 *   the vendor stocks + ships) bind each storefront SKU to a
 *   vendor `slug` + per-unit `cost_minor` (wholesale) + lead-time
 *   + return-policy snapshot. When an order containing those SKUs
 *   completes, `forwardOrder` writes one `dropship_forwardings`
 *   row per (order, vendor, SKU) so each line carries its own
 *   vendor_ref + carrier + tracking_number on the return leg —
 *   the vendor's downstream system stamps a per-line PO and the
 *   shop's worker reconciles the per-line shipment back to the
 *   customer order.
 *
 *   Distinct from `printOnDemand` (which bundles every line from
 *   one supplier into a single row + carries supplier-product-id
 *   + supplier-variant-id + artwork-url + position for the print
 *   pipeline). This primitive is the supplier-agnostic
 *   counterpart: any vendor that fulfills physical goods on the
 *   operator's behalf can be bound, with no print-specific
 *   metadata in the way.
 *
 *   The HTTP call to the vendor lives in the operator's worker —
 *   each vendor has its own auth shape + endpoint surface, and
 *   pinning a wire-format choice into the framework would shut
 *   out the operator whose vendor isn't yet wired. The worker
 *   reads `pendingForwardings`, calls the vendor, then calls back
 *   into this primitive's `markVendorAccepted` /
 *   `markVendorShipped` / `markVendorDelivered` /
 *   `markVendorFailed` / `markVendorReturned` to record each
 *   beat.
 *
 *   Lifecycle (six-state FSM):
 *
 *     queued     — written by forwardOrder
 *     accepted   — vendor acknowledged
 *     shipped    — vendor handed to carrier (carrier + tracking)
 *     delivered  — carrier confirmed delivery
 *     failed     — terminal; vendor refused or aborted
 *     returned   — terminal; customer returned
 *
 *   Allowed transitions:
 *     queued    -> accepted, failed
 *     accepted  -> shipped,  failed
 *     shipped   -> delivered, failed, returned
 *     delivered -> returned
 *
 *   Composition:
 *     - b.uuid.v7        — forwarding row PKs (sortable so audit
 *                          queries sort cleanly without an extra
 *                          index)
 *     - b.guardUuid      — strict UUID validation on read verbs +
 *                          transition entry points
 *     - b.fsm            — dropship_forwarding status FSM with the
 *                          transitions above
 *     - b.audit          — FSM emits transition events under "fsm"
 *
 *   Storage: `migrations-d1/0154_dropship_forwarding.sql`.
 *
 * @primitive dropshipForwarding
 * @related   b.fsm, b.uuid, shop.printOnDemand, shop.vendors
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var FORWARDING_STATUSES = Object.freeze([
  "queued", "accepted", "shipped", "delivered", "failed", "returned",
]);

// SKU shape matches the catalog + print-on-demand convention: alnum
// + . _ - with a 128-char ceiling. Vendor slug uses the lowercase
// alnum + dash convention shared with the vendors primitive (the
// two registries don't share a FK but they share an operator's
// muscle memory).
var SKU_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var SLUG_RE         = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
var CURRENCY_RE     = /^[A-Z]{3}$/;
var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;

var MAX_RETURN_POLICY_LEN  = 4000;
var MAX_VENDOR_REF_LEN     = 256;
var MAX_CARRIER_LEN        = 64;
var MAX_TRACKING_LEN       = 128;
var MAX_FAIL_REASON_LEN    = 4000;
var MAX_ADDRESS_JSON_LEN   = 8192;
var MAX_LEAD_TIME_DAYS     = 365;
var MAX_LIST_LIMIT         = 200;
var MAX_LINES              = 1000;

// ---- FSM definition -----------------------------------------------------

var _dsFsm = null;
function _getDropshipFsm() {
  if (_dsFsm) return _dsFsm;
  // b.fsm emits audit events under the "fsm" namespace — register
  // idempotently so the audit sink keeps the events instead of
  // dropping them with a noisy warning.
  try { b.audit.registerNamespace("fsm"); } catch (_e) { /* idempotent — sink already knows about the namespace */ }
  _dsFsm = b.fsm.define({
    name:    "dropship_forwarding",
    initial: "queued",
    states: {
      queued:    {},
      accepted:  {},
      shipped:   {},
      delivered: {},
      failed:    {},
      returned:  {},
    },
    transitions: [
      { from: "queued",    to: "accepted",  on: "accept"   },
      { from: "queued",    to: "failed",    on: "fail"     },
      { from: "accepted",  to: "shipped",   on: "ship"     },
      { from: "accepted",  to: "failed",    on: "fail"     },
      { from: "shipped",   to: "delivered", on: "deliver"  },
      { from: "shipped",   to: "failed",    on: "fail"     },
      { from: "shipped",   to: "returned",  on: "return"   },
      { from: "delivered", to: "returned",  on: "return"   },
    ],
  });
  return _dsFsm;
}

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("dropship-forwarding: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("dropship-forwarding: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}
function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("dropship-forwarding: " + (label || "vendor_slug") +
      " must be lowercase alnum + dash, no leading/trailing dash, 1..64 chars");
  }
}
function _costMinor(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("dropship-forwarding: cost_minor must be a non-negative integer (minor units)");
  }
}
function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("dropship-forwarding: currency must be a 3-letter uppercase ISO-4217 code");
  }
}
function _leadTimeDays(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_LEAD_TIME_DAYS) {
    throw new TypeError("dropship-forwarding: lead_time_days must be an integer 0.." + MAX_LEAD_TIME_DAYS);
  }
}
function _returnPolicy(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_RETURN_POLICY_LEN) {
    throw new TypeError("dropship-forwarding: return_policy must be a non-empty string <= " + MAX_RETURN_POLICY_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("dropship-forwarding: return_policy must not contain control bytes");
  }
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("dropship-forwarding: " + label + " must be a positive integer");
  }
}
function _shippingAddress(addr) {
  if (!addr || typeof addr !== "object" || Array.isArray(addr)) {
    throw new TypeError("dropship-forwarding: shipping_address must be a plain object");
  }
  if (typeof addr.country !== "string" || !/^[A-Z]{2}$/.test(addr.country)) {
    throw new TypeError("dropship-forwarding: shipping_address.country must be a 2-letter ISO 3166-1 code (uppercase)");
  }
  var encoded;
  try { encoded = JSON.stringify(addr); }
  catch (_e) {
    throw new TypeError("dropship-forwarding: shipping_address must be JSON-serialisable");
  }
  if (encoded.length > MAX_ADDRESS_JSON_LEN) {
    throw new TypeError("dropship-forwarding: shipping_address JSON must be <= " +
      MAX_ADDRESS_JSON_LEN + " characters serialised");
  }
  return encoded;
}
function _shortText(s, label, max) {
  if (typeof s !== "string" || !s.length || s.length > max) {
    throw new TypeError("dropship-forwarding: " + label + " must be a non-empty string <= " + max + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("dropship-forwarding: " + label + " must not contain control bytes");
  }
}
function _optTimestamp(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("dropship-forwarding: " + label + " must be a non-negative integer (epoch ms) when provided");
  }
  return n;
}
function _limit(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("dropship-forwarding: limit must be an integer in 1..." + MAX_LIST_LIMIT);
  }
}
function _windowTs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("dropship-forwarding: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

// ---- monotonic clock ---------------------------------------------------
//
// Operator-driven FSM transitions can land in the same millisecond
// on fast machines (markVendorAccepted immediately followed by
// markVendorShipped in a test, for instance). Bumping by 1ms on a
// tie keeps the timeline strictly increasing so a sort-by-occurred_at
// read returns the events in the order they were issued and the
// per-vendor metrics window contains the writes the test just made
// without a wall-clock race.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional handles. `vendors` lets the primitive refuse a bind
  // against an unknown / archived vendor slug when the operator is
  // running the vendors registry. `orderTracking` is reserved for
  // future composition — accepted at the factory so the surface
  // doesn't break when a downstream operator wires it for an event
  // emission on each FSM beat.
  var vendors      = opts.vendors      || null;
  var orderTracking = opts.orderTracking || null;
  void orderTracking;

  // Hydrate a binding row into the operator-facing shape (no
  // wire-format columns leak; the table layout IS the read shape).
  async function _getBindingRow(sku) {
    var r = await query("SELECT * FROM dropship_bindings WHERE sku = ?1", [sku]);
    if (!r.rows.length) return null;
    return r.rows[0];
  }

  async function _getForwardingRow(id) {
    var r = await query("SELECT * FROM dropship_forwardings WHERE id = ?1", [id]);
    if (!r.rows.length) return null;
    var row = r.rows[0];
    row.shipping_address = row.shipping_address_json
      ? JSON.parse(row.shipping_address_json) : {};
    return row;
  }

  // Replay the FSM against the row's current status, dispatch the
  // transition, and apply the matching column patch. Surfaces b.fsm
  // refusal as a typed error with the original cause attached so a
  // worker can distinguish "wrong state" from "unknown row" without
  // string-sniffing.
  async function _transitionForwarding(forwardingId, event, patch) {
    var current = await _getForwardingRow(forwardingId);
    if (!current) {
      throw new TypeError("dropship-forwarding: forwarding " + forwardingId + " not found");
    }
    var fsm = _getDropshipFsm();
    var instance = fsm.restore({
      state:   current.status,
      history: [],
      context: {},
    });
    try {
      await instance.transition(event, null);
    } catch (e) {
      var err = new Error("dropship-forwarding: forwarding transition refused — " + (e && e.message || e));
      err.code  = (e && e.code) || "DROPSHIP_FORWARDING_TRANSITION_REFUSED";
      err.cause = e;
      throw err;
    }
    var sets = ["status = ?1"];
    var params = [instance.state];
    var p = 2;
    var keys = Object.keys(patch || {});
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      // Each transition writes a known fixed set of columns; the
      // patch keys come from the primitive itself, never from
      // operator-controlled input. safeSql.assertOneOf is the
      // belt-and-braces gate so a future patch can't slip in an
      // operator-controlled column name.
      b.safeSql.assertOneOf(k, [
        "vendor_ref", "eta", "carrier", "tracking_number",
        "shipped_at", "delivered_at", "failed_at", "returned_at",
        "fail_reason",
      ]);
      sets.push(k + " = ?" + p);
      params.push(patch[k]);
      p += 1;
    }
    params.push(forwardingId);       // ?p
    params.push(current.status);     // ?(p+1)
    // Cross-instance atomic claim — the transaction substitute on the D1
    // bridge. b.fsm.transition above only validates the legal edge IN
    // MEMORY (its lock is per-instance, and each request restores a fresh
    // instance), so two concurrent transitions on the same row both pass
    // it. Gating the write on the row STILL being in the from-state we
    // validated against (`AND status = <from>`) is the single-statement
    // serialization point: exactly one writer changes the row, the loser
    // changes zero rows and is refused (no stale-edge clobber).
    var upd = await query(
      "UPDATE dropship_forwardings SET " + sets.join(", ") +
      " WHERE id = ?" + p + " AND status = ?" + (p + 1),
      params,
    );
    if (Number(upd.rowCount || 0) !== 1) {
      var raced = new Error("dropship-forwarding: forwarding " + forwardingId +
        " changed state concurrently (no longer " + current.status + ") — transition refused");
      raced.code = "DROPSHIP_FORWARDING_TRANSITION_REFUSED";
      throw raced;
    }
    return await _getForwardingRow(forwardingId);
  }

  return {
    FORWARDING_STATUSES: FORWARDING_STATUSES,

    bindSkuToVendor: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dropship-forwarding.bindSkuToVendor: input object required");
      }
      _sku(input.sku);
      _slug(input.vendor_slug, "vendor_slug");
      _costMinor(input.cost_minor);
      _currency(input.currency);
      _leadTimeDays(input.lead_time_days);
      _returnPolicy(input.return_policy);

      // Optional vendors-registry consistency: when the operator
      // wires the vendors primitive at factory time, refuse a bind
      // against an unknown or archived vendor slug. Without a
      // registry the primitive trusts the operator-supplied slug
      // (operators may run a flat vendor list outside the
      // registry).
      if (vendors && typeof vendors.getVendor === "function") {
        var v = await vendors.getVendor(input.vendor_slug);
        if (!v) {
          throw new TypeError("dropship-forwarding.bindSkuToVendor: vendor_slug " +
            JSON.stringify(input.vendor_slug) + " not found in vendors registry");
        }
        if (v.status === "archived") {
          throw new TypeError("dropship-forwarding.bindSkuToVendor: vendor_slug " +
            JSON.stringify(input.vendor_slug) + " is archived");
        }
      }

      // Refuse rebind via bindSkuToVendor — operators that want to
      // switch vendor for an existing SKU explicitly unbind first
      // (a future verb; until then operators DELETE the row out of
      // band when migrating vendors). The refusal keeps the create
      // path single-purpose and surfaces the "switching vendor"
      // choice explicitly.
      var existing = await _getBindingRow(input.sku);
      if (existing) {
        throw new TypeError("dropship-forwarding.bindSkuToVendor: sku " +
          JSON.stringify(input.sku) + " already bound to " + JSON.stringify(existing.vendor_slug) +
          " — DELETE the binding row before rebinding");
      }

      var ts = _now();
      await query(
        "INSERT INTO dropship_bindings (sku, vendor_slug, cost_minor, currency, " +
        "lead_time_days, return_policy, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
        [
          input.sku, input.vendor_slug, input.cost_minor, input.currency,
          input.lead_time_days, input.return_policy, ts,
        ],
      );
      return await _getBindingRow(input.sku);
    },

    // Write one forwarding row per (order, vendor, SKU). Lines
    // whose SKU has no binding are returned on `unbound_skus` and
    // do NOT create a row — the operator's pre-flight is expected
    // to refuse the checkout in that case; this primitive is
    // defensive in case it slips through. Lines whose binding is
    // archived are surfaced separately on `archived_skus`.
    forwardOrder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dropship-forwarding.forwardOrder: input object required");
      }
      _uuid(input.order_id, "order_id");
      if (!Array.isArray(input.lines) || input.lines.length === 0) {
        throw new TypeError("dropship-forwarding.forwardOrder: lines must be a non-empty array");
      }
      if (input.lines.length > MAX_LINES) {
        throw new TypeError("dropship-forwarding.forwardOrder: lines must contain <= " + MAX_LINES + " entries");
      }
      // Each line carries its own shipping address (drop-ship
      // commonly splits across customers — gift-with-purchase,
      // multi-recipient orders). The line-level address is the
      // forwarding row's binding; if the operator wants every line
      // to share the same address, they pass the same object on
      // every line.
      var normalized = [];
      for (var i = 0; i < input.lines.length; i += 1) {
        var l = input.lines[i];
        if (!l || typeof l !== "object") {
          throw new TypeError("dropship-forwarding.forwardOrder: lines[" + i + "] must be an object");
        }
        _sku(l.sku);
        _positiveInt(l.quantity, "lines[" + i + "].quantity");
        var encoded = _shippingAddress(l.shipping_address);
        normalized.push({ sku: l.sku, quantity: l.quantity, address_json: encoded });
      }

      var forwardingIds = [];
      var unbound = [];
      var archived = [];
      for (var j = 0; j < normalized.length; j += 1) {
        var line = normalized[j];
        var binding = await _getBindingRow(line.sku);
        if (!binding) { unbound.push(line.sku); continue; }
        if (binding.archived_at != null) { archived.push(line.sku); continue; }

        var id = b.uuid.v7();
        var ts = _now();
        await query(
          "INSERT INTO dropship_forwardings (id, order_id, vendor_slug, sku, quantity, " +
          "shipping_address_json, status, occurred_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7)",
          [
            id, input.order_id, binding.vendor_slug, line.sku, line.quantity,
            line.address_json, ts,
          ],
        );
        forwardingIds.push(id);
      }
      return {
        forwarding_ids: forwardingIds,
        unbound_skus:   unbound,
        archived_skus:  archived,
      };
    },

    markVendorAccepted: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dropship-forwarding.markVendorAccepted: input object required");
      }
      _uuid(input.forwarding_id, "forwarding_id");
      _shortText(input.vendor_ref, "vendor_ref", MAX_VENDOR_REF_LEN);
      var eta = _optTimestamp(input.eta, "eta");
      var patch = { vendor_ref: input.vendor_ref };
      if (eta != null) patch.eta = eta;
      return await _transitionForwarding(input.forwarding_id, "accept", patch);
    },

    markVendorShipped: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dropship-forwarding.markVendorShipped: input object required");
      }
      _uuid(input.forwarding_id, "forwarding_id");
      _shortText(input.carrier, "carrier", MAX_CARRIER_LEN);
      _shortText(input.tracking_number, "tracking_number", MAX_TRACKING_LEN);
      var shippedAt = _optTimestamp(input.shipped_at, "shipped_at");
      if (shippedAt == null) shippedAt = _now();
      return await _transitionForwarding(input.forwarding_id, "ship", {
        carrier:         input.carrier,
        tracking_number: input.tracking_number,
        shipped_at:      shippedAt,
      });
    },

    markVendorDelivered: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dropship-forwarding.markVendorDelivered: input object required");
      }
      _uuid(input.forwarding_id, "forwarding_id");
      var deliveredAt = _optTimestamp(input.delivered_at, "delivered_at");
      if (deliveredAt == null) deliveredAt = _now();
      return await _transitionForwarding(input.forwarding_id, "deliver", {
        delivered_at: deliveredAt,
      });
    },

    markVendorFailed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dropship-forwarding.markVendorFailed: input object required");
      }
      _uuid(input.forwarding_id, "forwarding_id");
      _shortText(input.reason, "reason", MAX_FAIL_REASON_LEN);
      return await _transitionForwarding(input.forwarding_id, "fail", {
        fail_reason: input.reason,
        failed_at:   _now(),
      });
    },

    markVendorReturned: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dropship-forwarding.markVendorReturned: input object required");
      }
      _uuid(input.forwarding_id, "forwarding_id");
      var returnedAt = _optTimestamp(input.returned_at, "returned_at");
      if (returnedAt == null) returnedAt = _now();
      return await _transitionForwarding(input.forwarding_id, "return", {
        returned_at: returnedAt,
      });
    },

    getForwarding: async function (id) {
      _uuid(id, "forwarding_id");
      return await _getForwardingRow(id);
    },

    // All forwardings for one order, ordered by occurred_at ASC
    // (the order the per-vendor rows were written). Operators
    // rendering an order detail page get the vendor-by-vendor
    // breakdown in the order the forward fired.
    forwardingsForOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      var rows = (await query(
        "SELECT * FROM dropship_forwardings WHERE order_id = ?1 " +
        "ORDER BY occurred_at ASC, id ASC",
        [orderId],
      )).rows;
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].shipping_address = rows[i].shipping_address_json
          ? JSON.parse(rows[i].shipping_address_json) : {};
      }
      return rows;
    },

    // Worker queue drain: queued + accepted rows in FIFO order so
    // the longest-waiting forwarding goes first. Optional
    // vendor_slug filter narrows to one vendor's worker. `accepted`
    // is included because an operator's tracking-polling worker
    // wants to revisit rows that the vendor acknowledged but
    // hasn't yet shipped — once a row hits shipped it falls off
    // the pending queue (the carrier-side tracking takes over).
    pendingForwardings: async function (listOpts) {
      listOpts = listOpts || {};
      var vendorSlug = null;
      if (listOpts.vendor_slug != null) {
        _slug(listOpts.vendor_slug, "vendor_slug");
        vendorSlug = listOpts.vendor_slug;
      }
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      _limit(limit);

      var sql, params;
      if (vendorSlug) {
        sql = "SELECT * FROM dropship_forwardings " +
              "WHERE status IN ('queued', 'accepted') AND vendor_slug = ?1 " +
              "ORDER BY occurred_at ASC, id ASC LIMIT ?2";
        params = [vendorSlug, limit];
      } else {
        sql = "SELECT * FROM dropship_forwardings " +
              "WHERE status IN ('queued', 'accepted') " +
              "ORDER BY occurred_at ASC, id ASC LIMIT ?1";
        params = [limit];
      }
      var rows = (await query(sql, params)).rows;
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].shipping_address = rows[i].shipping_address_json
          ? JSON.parse(rows[i].shipping_address_json) : {};
      }
      return rows;
    },

    // Per-vendor performance metrics across a closed [from, to)
    // window. Returns counts by terminal status + the average
    // fulfillment latency (queued occurred_at -> shipped_at) for
    // every shipped forwarding in the window. Operators read this
    // to drive vendor scorecards: "this vendor shipped 87% of
    // orders in the window with a median of 2.1 days from queue
    // to shipment."
    //
    // `from` and `to` are epoch-ms ints; the window is [from, to)
    // against `occurred_at` (the queued-at stamp). A forwarding
    // that's still queued at `to` counts toward `queued`; one that
    // shipped before `to` counts toward `shipped` regardless of
    // when shipped_at fired (the audit grain is the queued event).
    metricsForVendor: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("dropship-forwarding.metricsForVendor: input object required");
      }
      _slug(input.slug, "slug");
      var from = _windowTs(input.from, "from");
      var to   = _windowTs(input.to,   "to");
      if (to <= from) {
        throw new TypeError("dropship-forwarding.metricsForVendor: to must be > from");
      }
      var rows = (await query(
        "SELECT status, occurred_at, shipped_at FROM dropship_forwardings " +
        "WHERE vendor_slug = ?1 AND occurred_at >= ?2 AND occurred_at < ?3",
        [input.slug, from, to],
      )).rows;

      var counts = {
        queued: 0, accepted: 0, shipped: 0,
        delivered: 0, failed: 0, returned: 0,
      };
      var shippedCount = 0;
      var totalLatencyMs = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var r = rows[i];
        if (Object.prototype.hasOwnProperty.call(counts, r.status)) {
          counts[r.status] += 1;
        }
        // Shipped-or-better rows that carry a shipped_at stamp
        // contribute to the latency average. The audit grain is
        // the queued -> shipped delta — once the carrier has the
        // package the vendor's responsibility is discharged.
        if (r.shipped_at != null && r.shipped_at >= r.occurred_at) {
          shippedCount += 1;
          totalLatencyMs += (r.shipped_at - r.occurred_at);
        }
      }
      return {
        slug:                 input.slug,
        from:                 from,
        to:                   to,
        total:                rows.length,
        counts:               counts,
        avg_ship_latency_ms:  shippedCount > 0 ? Math.floor(totalLatencyMs / shippedCount) : null,
        shipped_for_latency:  shippedCount,
      };
    },
  };
}

module.exports = {
  create:              create,
  FORWARDING_STATUSES: FORWARDING_STATUSES,
  // Exposed so the test suite can assert the FSM shape without
  // re-deriving the definition from the transitions table.
  _getDropshipFsm:     _getDropshipFsm,
};
