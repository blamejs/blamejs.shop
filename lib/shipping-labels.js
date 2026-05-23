"use strict";
/**
 * @module shop.shippingLabels
 * @title  Shipping labels — operator-side carrier label store
 *
 * @intro
 *   Sibling to `orderTracking`: where the tracking primitive owns the
 *   per-shipment carrier-event ledger, the labels primitive owns the
 *   broker-side artefact — the carrier-minted tracking number, the
 *   PDF/ZPL URL the warehouse prints, the final cost the broker
 *   charged, and the lifecycle around purchase / void / hand-off.
 *
 *   The framework does NOT call EasyPost / Shippo / ShipStation /
 *   Stamps.com directly. Each broker has its own auth + endpoint
 *   shape; the operator's worker drains `pendingLabels`, calls the
 *   broker, and calls back into this primitive (`markPurchased`)
 *   with the minted result. `purchased_via` enum records which
 *   broker (or manual / custom) the label came from.
 *
 *   Lifecycle:
 *     pending   → purchased   (broker minted; tracking + url known)
 *     purchased → voided      (broker void; refused past 30 days)
 *     purchased → used        (warehouse handed parcel to carrier)
 *
 *   Composition:
 *     - `b.guardUuid`   — strict UUID validation on every id input
 *     - `b.uuid.v7`     — label row PK
 *     - `b.safeUrl`     — `label_url` is the PDF/ZPL the warehouse
 *                         renders; allowedProtocols pinned to https:
 *                         so a hostile broker response can't smuggle
 *                         a `javascript:` or `data:` URL into the
 *                         operator's print queue
 *
 *   Storage:
 *     - `shipping_labels` (migration `0051_shipping_labels.sql`).
 *
 *   Surface:
 *     - `requestLabel({...})`           — pending row.
 *     - `markPurchased({...})`          — pending → purchased.
 *     - `voidLabel({...})`              — purchased → voided (30-day window).
 *     - `markUsed({label_id})`          — purchased → used.
 *     - `getLabel(id)`                  — single label, with parsed customs.
 *     - `labelsForShipment(shipment_id)` — per-shipment list.
 *     - `labelsForOrder(order_id)`      — joined across the order's
 *                                          shipments; the order is
 *                                          the operator-facing root.
 *     - `pendingLabels({limit?})`       — worker queue drain.
 *     - `voidedInWindow({from, to})`    — operator reporting; epoch-ms
 *                                          inclusive bounds.
 *     - `costsByPeriod({from, to, carrier?})` — aggregate cost +
 *                                          count grouped by
 *                                          purchased_via (broker
 *                                          spend report).
 *     - `customsForLabel(label_id)`     — returns the operator's
 *                                          customs shape (parsed JSON
 *                                          plus a normalized view).
 *
 * @related b.safeUrl, b.guardUuid, b.uuid
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var CARRIERS = Object.freeze([
  "ups", "fedex", "usps", "dhl",
  "royal-mail", "canada-post", "australia-post", "other",
]);

var PACKAGE_TYPES = Object.freeze(["envelope", "parcel", "pak", "custom"]);

var STATUSES = Object.freeze(["pending", "purchased", "voided", "used"]);

var PURCHASED_VIA = Object.freeze([
  "easypost", "shippo", "shipstation", "stamps_com", "manual", "custom",
]);

var MAX_SERVICE_LEVEL_LEN = 64;
var MAX_TRACKING_LEN      = 64;
var MAX_LABEL_URL_LEN     = 2048;
var MAX_REASON_LEN        = 512;
var MAX_HS_CODE_LEN       = 16;
var MAX_DESCRIPTION_LEN   = 256;
var MAX_CUSTOMS_LINES     = 100;

var DEFAULT_PENDING_LIMIT = 25;
var MAX_PENDING_LIMIT     = 200;

var VOID_WINDOW_MS        = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("shipping-labels: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _carrier(c) {
  if (typeof c !== "string" || CARRIERS.indexOf(c) === -1) {
    throw new TypeError("shipping-labels: carrier must be one of " + CARRIERS.join(", "));
  }
}

function _packageType(p) {
  if (typeof p !== "string" || PACKAGE_TYPES.indexOf(p) === -1) {
    throw new TypeError("shipping-labels: package_type must be one of " + PACKAGE_TYPES.join(", "));
  }
}

function _purchasedVia(p) {
  if (typeof p !== "string" || PURCHASED_VIA.indexOf(p) === -1) {
    throw new TypeError("shipping-labels: purchased_via must be one of " + PURCHASED_VIA.join(", "));
  }
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("shipping-labels: " + label + " must be a positive integer");
  }
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("shipping-labels: " + label + " must be a non-negative integer");
  }
}

function _currency(c) {
  if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("shipping-labels: currency must be 3-letter uppercase ISO 4217");
  }
}

// C0 + DEL refusal — same pattern orderTracking uses, kept as a
// charCodeAt walk so the `no-control-regex` ESLint rule stays clean.
function _hasControlByte(s) {
  for (var i = 0; i < s.length; i += 1) {
    var cc = s.charCodeAt(i);
    if (cc <= 0x1f || cc === 0x7f) return true;
  }
  return false;
}

function _shortText(s, label, max) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("shipping-labels: " + label + " must be a non-empty string");
  }
  if (s.length > max) {
    throw new TypeError("shipping-labels: " + label + " must be <= " + max + " chars");
  }
  if (_hasControlByte(s)) {
    throw new TypeError("shipping-labels: " + label + " must not contain control characters");
  }
  return s;
}

function _optShortText(s, label, max) {
  if (s == null || s === "") return null;
  return _shortText(s, label, max);
}

function _labelUrl(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_LABEL_URL_LEN) {
    throw new TypeError("shipping-labels: label_url must be a non-empty string <= " + MAX_LABEL_URL_LEN + " chars");
  }
  if (_hasControlByte(s)) {
    throw new TypeError("shipping-labels: label_url must not contain control characters");
  }
  // The warehouse prints whatever this URL serves. A hostile broker
  // response that smuggled `javascript:` / `data:` / `file:` would
  // turn the print queue into a foothold; pin allowedProtocols to
  // https: so the safeUrl gate refuses anything else.
  try {
    _b().safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("shipping-labels: label_url — " + (e && e.message || "must be a valid https:// URL"));
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("shipping-labels: " + label + " must be a positive integer epoch-ms");
  }
  return n;
}

function _customs(c) {
  if (c == null) return null;
  if (typeof c !== "object" || Array.isArray(c)) {
    throw new TypeError("shipping-labels: customs_declaration must be an object when provided");
  }
  if (typeof c.contents_type !== "string" || !c.contents_type.length) {
    throw new TypeError("shipping-labels: customs_declaration.contents_type required");
  }
  // contents_type is broker-vocabulary (merchandise / documents /
  // gift / sample / returned_goods / other). The framework doesn't
  // pin the enum — every broker wires a slightly different set, and
  // the operator's worker translates. Just refuse control bytes +
  // cap length so a malicious payload can't blow out storage.
  if (c.contents_type.length > 64 || _hasControlByte(c.contents_type)) {
    throw new TypeError("shipping-labels: customs_declaration.contents_type must be a clean string <= 64 chars");
  }
  if (typeof c.origin_country !== "string" || !/^[A-Z]{2}$/.test(c.origin_country)) {
    throw new TypeError("shipping-labels: customs_declaration.origin_country must be 2-letter ISO 3166-1 (uppercase)");
  }
  if (!Array.isArray(c.lines) || c.lines.length === 0) {
    throw new TypeError("shipping-labels: customs_declaration.lines must be a non-empty array");
  }
  if (c.lines.length > MAX_CUSTOMS_LINES) {
    throw new TypeError("shipping-labels: customs_declaration.lines must be <= " + MAX_CUSTOMS_LINES + " entries");
  }
  for (var i = 0; i < c.lines.length; i += 1) {
    var line = c.lines[i];
    if (!line || typeof line !== "object" || Array.isArray(line)) {
      throw new TypeError("shipping-labels: customs_declaration.lines[" + i + "] must be an object");
    }
    if (typeof line.description !== "string" || !line.description.length || line.description.length > MAX_DESCRIPTION_LEN) {
      throw new TypeError("shipping-labels: customs_declaration.lines[" + i + "].description must be a non-empty string <= " + MAX_DESCRIPTION_LEN + " chars");
    }
    if (_hasControlByte(line.description)) {
      throw new TypeError("shipping-labels: customs_declaration.lines[" + i + "].description must not contain control characters");
    }
    if (typeof line.hs_code !== "string" || !line.hs_code.length || line.hs_code.length > MAX_HS_CODE_LEN) {
      throw new TypeError("shipping-labels: customs_declaration.lines[" + i + "].hs_code must be a non-empty string <= " + MAX_HS_CODE_LEN + " chars");
    }
    if (!/^[0-9.]+$/.test(line.hs_code)) {
      throw new TypeError("shipping-labels: customs_declaration.lines[" + i + "].hs_code must be digits/dots only");
    }
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new TypeError("shipping-labels: customs_declaration.lines[" + i + "].quantity must be a positive integer");
    }
    if (!Number.isInteger(line.value_minor) || line.value_minor < 0) {
      throw new TypeError("shipping-labels: customs_declaration.lines[" + i + "].value_minor must be a non-negative integer");
    }
    if (typeof line.origin_country !== "string" || !/^[A-Z]{2}$/.test(line.origin_country)) {
      throw new TypeError("shipping-labels: customs_declaration.lines[" + i + "].origin_country must be 2-letter ISO 3166-1 (uppercase)");
    }
  }
  return c;
}

function _trackingNumber(n) {
  if (typeof n !== "string" || !n.length) {
    throw new TypeError("shipping-labels: tracking_number must be a non-empty string");
  }
  if (n.length > MAX_TRACKING_LEN) {
    throw new TypeError("shipping-labels: tracking_number must be <= " + MAX_TRACKING_LEN + " chars");
  }
  if (_hasControlByte(n)) {
    throw new TypeError("shipping-labels: tracking_number must not contain control characters");
  }
  return n;
}

function _limit(n, label) {
  if (n == null) return DEFAULT_PENDING_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_PENDING_LIMIT) {
    throw new TypeError("shipping-labels: " + label + " must be an integer in 1..." + MAX_PENDING_LIMIT);
  }
  return n;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // The cursorSecret param is reserved — the surface area as
  // specified doesn't paginate (the worker drain is a `limit`-bounded
  // SELECT, not a cursor walk). Operators wiring custom paged
  // reporting on top can pass it through; it's stored on the factory
  // closure for forward compatibility without surfacing a half-paged
  // API today.
  var cursorSecret = opts.cursorSecret || null;
  if (cursorSecret != null && (typeof cursorSecret !== "string" || !cursorSecret.length)) {
    throw new TypeError("shipping-labels.create: opts.cursorSecret must be a non-empty string when provided");
  }

  async function _getLabelRow(labelId) {
    var r = await query("SELECT * FROM shipping_labels WHERE id = ?1", [labelId]);
    if (!r.rows.length) return null;
    return _hydrate(r.rows[0]);
  }

  async function _shipmentExists(shipmentId) {
    var r = await query("SELECT id FROM shipments WHERE id = ?1", [shipmentId]);
    return r.rows.length > 0;
  }

  function _hydrate(row) {
    if (!row) return null;
    if (row.customs_json) {
      try { row.customs = JSON.parse(row.customs_json); }
      catch (_e) { row.customs = null; }
    } else {
      row.customs = null;
    }
    return row;
  }

  return {
    CARRIERS:      CARRIERS,
    STATUSES:      STATUSES,
    PACKAGE_TYPES: PACKAGE_TYPES,
    PURCHASED_VIA: PURCHASED_VIA,

    requestLabel: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("shipping-labels.requestLabel: input object required");
      }
      _uuid(input.shipment_id, "shipment_id");
      _carrier(input.carrier);
      _shortText(input.service_level, "service_level", MAX_SERVICE_LEVEL_LEN);
      _positiveInt(input.weight_grams, "weight_grams");
      _positiveInt(input.length_mm,    "length_mm");
      _positiveInt(input.width_mm,     "width_mm");
      _positiveInt(input.height_mm,    "height_mm");
      _packageType(input.package_type);
      var customs = _customs(input.customs_declaration);

      // FK enforces the shipment exists too, but a typed refusal
      // up-front is the better operator-facing message than the raw
      // SQLITE_CONSTRAINT bubble.
      var ok = await _shipmentExists(input.shipment_id);
      if (!ok) {
        throw new TypeError("shipping-labels.requestLabel: shipment " + input.shipment_id + " not found");
      }

      var id = _b().uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO shipping_labels (id, shipment_id, carrier, service_level, " +
        "weight_grams, length_mm, width_mm, height_mm, package_type, status, " +
        "customs_json, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, ?11)",
        [
          id, input.shipment_id, input.carrier, input.service_level,
          input.weight_grams, input.length_mm, input.width_mm, input.height_mm,
          input.package_type, customs ? JSON.stringify(customs) : null, ts,
        ],
      );
      return { id: id, status: "pending", created_at: ts };
    },

    markPurchased: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("shipping-labels.markPurchased: input object required");
      }
      _uuid(input.label_id, "label_id");
      var tracking = _trackingNumber(input.tracking_number);
      var url      = _labelUrl(input.label_url);
      _nonNegInt(input.cost_minor, "cost_minor");
      _currency(input.currency);
      _purchasedVia(input.purchased_via);

      var row = await _getLabelRow(input.label_id);
      if (!row) {
        throw new TypeError("shipping-labels.markPurchased: label " + input.label_id + " not found");
      }
      if (row.status !== "pending") {
        var err = new Error("shipping-labels.markPurchased: refused — label is " + row.status + " (only pending → purchased is valid)");
        err.code = "SHIPPING_LABELS_TRANSITION_REFUSED";
        throw err;
      }

      var ts = _now();
      await query(
        "UPDATE shipping_labels SET status = 'purchased', tracking_number = ?1, " +
        "label_url = ?2, cost_minor = ?3, currency = ?4, purchased_via = ?5, " +
        "purchased_at = ?6 WHERE id = ?7",
        [tracking, url, input.cost_minor, input.currency, input.purchased_via, ts, input.label_id],
      );
      return await _getLabelRow(input.label_id);
    },

    voidLabel: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("shipping-labels.voidLabel: input object required");
      }
      _uuid(input.label_id, "label_id");
      var reason = _shortText(input.reason, "reason", MAX_REASON_LEN);

      var row = await _getLabelRow(input.label_id);
      if (!row) {
        throw new TypeError("shipping-labels.voidLabel: label " + input.label_id + " not found");
      }
      if (row.status !== "purchased") {
        var err = new Error("shipping-labels.voidLabel: refused — label is " + row.status + " (only purchased → voided is valid)");
        err.code = "SHIPPING_LABELS_TRANSITION_REFUSED";
        throw err;
      }
      var ts = _now();
      // Application-tier 30-day window. The broker may also refuse
      // independently — that error surfaces via the operator's worker
      // when it forwards the void to the broker.
      if (ts - row.purchased_at > VOID_WINDOW_MS) {
        var werr = new Error("shipping-labels.voidLabel: refused — label was purchased more than 30 days ago (" +
          Math.floor((ts - row.purchased_at) / 86400000) + " days)");
        werr.code = "SHIPPING_LABELS_VOID_WINDOW_EXPIRED";
        throw werr;
      }

      await query(
        "UPDATE shipping_labels SET status = 'voided', void_reason = ?1, voided_at = ?2 WHERE id = ?3",
        [reason, ts, input.label_id],
      );
      return await _getLabelRow(input.label_id);
    },

    markUsed: async function (input) {
      // Accept either `markUsed(labelId)` or `markUsed({ label_id })`
      // — operators land on either shape depending on whether they
      // came from the worker drain (which passes the row) or the
      // warehouse-scanner path (which passes the id directly).
      var labelId;
      if (typeof input === "string") {
        labelId = input;
      } else if (input && typeof input === "object") {
        labelId = input.label_id;
      }
      _uuid(labelId, "label_id");

      var row = await _getLabelRow(labelId);
      if (!row) {
        throw new TypeError("shipping-labels.markUsed: label " + labelId + " not found");
      }
      if (row.status !== "purchased") {
        var err = new Error("shipping-labels.markUsed: refused — label is " + row.status + " (only purchased → used is valid)");
        err.code = "SHIPPING_LABELS_TRANSITION_REFUSED";
        throw err;
      }
      var ts = _now();
      await query(
        "UPDATE shipping_labels SET status = 'used', used_at = ?1 WHERE id = ?2",
        [ts, labelId],
      );
      return await _getLabelRow(labelId);
    },

    getLabel: async function (labelId) {
      _uuid(labelId, "label_id");
      return await _getLabelRow(labelId);
    },

    labelsForShipment: async function (shipmentId) {
      _uuid(shipmentId, "shipment_id");
      var rows = (await query(
        "SELECT * FROM shipping_labels WHERE shipment_id = ?1 ORDER BY created_at ASC, id ASC",
        [shipmentId],
      )).rows;
      for (var i = 0; i < rows.length; i += 1) _hydrate(rows[i]);
      return rows;
    },

    labelsForOrder: async function (orderId) {
      _uuid(orderId, "order_id");
      // Join through shipments — the order doesn't reference labels
      // directly. ORDER BY label created_at + id keeps the listing
      // deterministic across split-shipment orders.
      var rows = (await query(
        "SELECT l.* FROM shipping_labels l " +
        "JOIN shipments s ON s.id = l.shipment_id " +
        "WHERE s.order_id = ?1 " +
        "ORDER BY l.created_at ASC, l.id ASC",
        [orderId],
      )).rows;
      for (var i = 0; i < rows.length; i += 1) _hydrate(rows[i]);
      return rows;
    },

    pendingLabels: async function (opts2) {
      opts2 = opts2 || {};
      var limit = _limit(opts2.limit, "limit");
      var rows = (await query(
        "SELECT * FROM shipping_labels WHERE status = 'pending' " +
        "ORDER BY created_at ASC, id ASC LIMIT ?1",
        [limit],
      )).rows;
      for (var i = 0; i < rows.length; i += 1) _hydrate(rows[i]);
      return rows;
    },

    voidedInWindow: async function (opts2) {
      if (!opts2 || typeof opts2 !== "object") {
        throw new TypeError("shipping-labels.voidedInWindow: opts object required");
      }
      var from = _epochMs(opts2.from, "from");
      var to   = _epochMs(opts2.to,   "to");
      if (to < from) {
        throw new TypeError("shipping-labels.voidedInWindow: to must be >= from");
      }
      var rows = (await query(
        "SELECT * FROM shipping_labels " +
        "WHERE status = 'voided' AND voided_at >= ?1 AND voided_at <= ?2 " +
        "ORDER BY voided_at ASC, id ASC",
        [from, to],
      )).rows;
      for (var i = 0; i < rows.length; i += 1) _hydrate(rows[i]);
      return rows;
    },

    costsByPeriod: async function (opts2) {
      if (!opts2 || typeof opts2 !== "object") {
        throw new TypeError("shipping-labels.costsByPeriod: opts object required");
      }
      var from = _epochMs(opts2.from, "from");
      var to   = _epochMs(opts2.to,   "to");
      if (to < from) {
        throw new TypeError("shipping-labels.costsByPeriod: to must be >= from");
      }
      var carrierFilter = null;
      if (opts2.carrier != null) {
        _carrier(opts2.carrier);
        carrierFilter = opts2.carrier;
      }
      // Group by purchased_via + currency so a multi-currency
      // operator gets per-currency totals (mixing USD + EUR into a
      // single SUM is silently lossy). Aggregate over purchased +
      // voided + used — every label that was minted contributes
      // operator spend; a void may or may not refund (broker-
      // dependent), but the framework reports the gross cost.
      var sql =
        "SELECT purchased_via, currency, COUNT(*) AS label_count, " +
        "       COALESCE(SUM(cost_minor), 0) AS total_minor " +
        "FROM shipping_labels " +
        "WHERE purchased_at IS NOT NULL " +
        "  AND purchased_at >= ?1 AND purchased_at <= ?2 ";
      var params = [from, to];
      if (carrierFilter) {
        sql += "  AND carrier = ?3 ";
        params.push(carrierFilter);
      }
      sql += "GROUP BY purchased_via, currency ORDER BY purchased_via ASC, currency ASC";
      var rows = (await query(sql, params)).rows;
      // Coerce SQLite's number/bigint into a plain number — the
      // aggregate columns can come back as bigint on large totals,
      // which JSON.stringify refuses without a replacer. Cost-by-
      // period output is operator-facing reporting, not the source
      // of truth for ledger math, so number is the right shape.
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].label_count = Number(rows[i].label_count);
        rows[i].total_minor = Number(rows[i].total_minor);
      }
      return rows;
    },

    customsForLabel: async function (labelId) {
      _uuid(labelId, "label_id");
      var row = await _getLabelRow(labelId);
      if (!row) return null;
      if (!row.customs) return null;
      // Return the parsed declaration plus a normalized totals view —
      // the operator's preferred shape for downstream broker
      // translation. The raw declaration is preserved verbatim so a
      // broker-specific extra field (rotation, sub-classification)
      // round-trips.
      var customs = row.customs;
      var totalValueMinor = 0;
      var totalItems      = 0;
      if (Array.isArray(customs.lines)) {
        for (var i = 0; i < customs.lines.length; i += 1) {
          var line = customs.lines[i];
          if (line && typeof line.value_minor === "number") {
            totalValueMinor += line.value_minor * (line.quantity || 1);
          }
          if (line && typeof line.quantity === "number") {
            totalItems += line.quantity;
          }
        }
      }
      return {
        label_id:          row.id,
        shipment_id:       row.shipment_id,
        contents_type:     customs.contents_type,
        origin_country:    customs.origin_country,
        lines:             customs.lines,
        total_value_minor: totalValueMinor,
        total_items:       totalItems,
        raw:               customs,
      };
    },
  };
}

module.exports = {
  create:        create,
  CARRIERS:      CARRIERS,
  PACKAGE_TYPES: PACKAGE_TYPES,
  STATUSES:      STATUSES,
  PURCHASED_VIA: PURCHASED_VIA,
};
