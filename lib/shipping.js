"use strict";
/**
 * @module shop.shipping
 * @title  Shipping primitive — pluggable adapter, operator-table built in
 *
 * @intro
 *   Pure-function shipping-rate computation against an operator-
 *   declared service catalog. v1 ships the `operatorTable` adapter;
 *   the same `{ rates(ctx) }` contract is what future EasyPost /
 *   Shippo / FedEx / UPS adapters return.
 *
 *   Service shape:
 *
 *     {
 *       id:               "standard",
 *       label:            "Standard (3-5 days)",
 *       zones: [{
 *         country:        "US",
 *         state?:         "CA",
 *         postal_prefix?: "9",
 *         flat_amount_minor?: 695,        // pick one of flat OR per-gram
 *         per_gram_minor?:   2,           // 2 minor units per gram
 *         base_minor?:        500,         // base fee added to per-gram
 *         min_amount_minor?:  295,         // floor — never below this
 *         max_amount_minor?: 9995,         // ceiling — never above this
 *       }],
 *       free_over_minor?:  7500,           // subtotal threshold for free
 *       digital_only?:     false,          // service offered only when
 *                                          // no line requires shipping
 *     }
 *
 *   `rates({ shipTo, lines, subtotal_minor })` returns the available
 *   services for the destination, each priced. Services that don't
 *   match any zone for the destination are omitted.
 *
 *   Line-level `requires_shipping` flag: lines come from
 *   `cart.listLines()` joined with variant data. When ALL lines have
 *   `requires_shipping: false` (digital cart), only `digital_only`
 *   services are offered (typically just "no shipping required").
 *   When ANY line requires shipping, digital-only services are
 *   filtered out.
 */

var COUNTRY_RE = /^[A-Z]{2}$/;
var STATE_RE   = /^[A-Z0-9]{1,5}$/;
var SERVICE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function _country(c, label) {
  if (typeof c !== "string" || !COUNTRY_RE.test(c)) {
    throw new TypeError("shipping: " + label + " must be a 2-letter ISO 3166-1 country code (uppercase)");
  }
}
function _serviceId(s) {
  if (typeof s !== "string" || !SERVICE_ID_RE.test(s)) {
    throw new TypeError("shipping: service id must match /^[a-z0-9][a-z0-9_-]{0,63}$/");
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("shipping: " + label + " must be a non-negative integer (minor units)");
  }
}

function _validateZone(zone, sid, zi) {
  if (!zone || typeof zone !== "object") throw new TypeError("shipping: service[" + sid + "].zones[" + zi + "] must be an object");
  _country(zone.country, "service[" + sid + "].zones[" + zi + "].country");
  if (zone.state !== undefined && (typeof zone.state !== "string" || !STATE_RE.test(zone.state))) {
    throw new TypeError("shipping: service[" + sid + "].zones[" + zi + "].state invalid");
  }
  if (zone.postal_prefix !== undefined && (typeof zone.postal_prefix !== "string" || !/^[A-Za-z0-9 -]{1,16}$/.test(zone.postal_prefix))) {
    throw new TypeError("shipping: service[" + sid + "].zones[" + zi + "].postal_prefix invalid");
  }
  var hasFlat   = zone.flat_amount_minor != null;
  var hasPerGram = zone.per_gram_minor != null;
  if (!hasFlat && !hasPerGram) {
    throw new TypeError("shipping: service[" + sid + "].zones[" + zi + "] must declare flat_amount_minor or per_gram_minor");
  }
  if (hasFlat && hasPerGram) {
    throw new TypeError("shipping: service[" + sid + "].zones[" + zi + "] cannot declare both flat_amount_minor and per_gram_minor");
  }
  if (hasFlat)    _nonNegInt(zone.flat_amount_minor, "flat_amount_minor");
  if (hasPerGram) _nonNegInt(zone.per_gram_minor,    "per_gram_minor");
  if (zone.base_minor       != null) _nonNegInt(zone.base_minor,       "base_minor");
  if (zone.min_amount_minor != null) _nonNegInt(zone.min_amount_minor, "min_amount_minor");
  if (zone.max_amount_minor != null) _nonNegInt(zone.max_amount_minor, "max_amount_minor");
}

function _matches(zone, shipTo) {
  if (zone.country !== shipTo.country) return false;
  if (zone.state && zone.state !== shipTo.state) return false;
  if (zone.postal_prefix) {
    if (!shipTo.postal) return false;
    if (shipTo.postal.indexOf(zone.postal_prefix) !== 0) return false;
  }
  return true;
}

function _specificity(zone) {
  return (zone.country ? 1 : 0) + (zone.state ? 2 : 0) + (zone.postal_prefix ? 4 : 0);
}

function _quoteZone(zone, totalGrams) {
  var amount;
  if (zone.flat_amount_minor != null) {
    amount = zone.flat_amount_minor;
  } else {
    amount = (zone.base_minor || 0) + zone.per_gram_minor * totalGrams;
  }
  if (zone.min_amount_minor != null && amount < zone.min_amount_minor) amount = zone.min_amount_minor;
  if (zone.max_amount_minor != null && amount > zone.max_amount_minor) amount = zone.max_amount_minor;
  return amount;
}

function operatorTable(opts) {
  opts = opts || {};
  if (!Array.isArray(opts.services) || opts.services.length === 0) {
    throw new TypeError("shipping.operatorTable: opts.services must be a non-empty array");
  }
  var services = opts.services.map(function (s) {
    _serviceId(s.id);
    if (typeof s.label !== "string" || !s.label.length) throw new TypeError("shipping: service[" + s.id + "].label must be a non-empty string");
    if (!Array.isArray(s.zones) || s.zones.length === 0) throw new TypeError("shipping: service[" + s.id + "].zones must be a non-empty array");
    s.zones.forEach(function (z, zi) { _validateZone(z, s.id, zi); });
    if (s.free_over_minor != null) _nonNegInt(s.free_over_minor, "free_over_minor");
    return Object.freeze(Object.assign({}, s, {
      zones: s.zones.slice().sort(function (a, b) { return _specificity(b) - _specificity(a); }),
    }));
  });

  return {
    name: "operatorTable",
    rates: async function (ctx) {
      if (!ctx || typeof ctx !== "object") throw new TypeError("shipping.rates: ctx object required");
      if (!ctx.shipTo || typeof ctx.shipTo !== "object") throw new TypeError("shipping.rates: ctx.shipTo required");
      _country(ctx.shipTo.country, "shipTo.country");
      if (!Array.isArray(ctx.lines)) throw new TypeError("shipping.rates: ctx.lines must be an array");
      _nonNegInt(ctx.subtotal_minor, "subtotal_minor");

      // Determine cart shipping shape.
      var anyShippable = ctx.lines.some(function (l) {
        return l.requires_shipping === undefined ? true : !!l.requires_shipping;
      });
      var totalGrams = ctx.lines.reduce(function (s, l) {
        if (l.requires_shipping === false) return s;
        var w = (l.weight_grams || 0) * (l.qty || 1);
        return s + w;
      }, 0);

      var quotes = [];
      for (var i = 0; i < services.length; i += 1) {
        var svc = services[i];
        if (anyShippable && svc.digital_only) continue;
        if (!anyShippable && !svc.digital_only) continue;
        var zone = null;
        for (var zi = 0; zi < svc.zones.length; zi += 1) {
          if (_matches(svc.zones[zi], ctx.shipTo)) { zone = svc.zones[zi]; break; }
        }
        if (!zone) continue;
        var raw = _quoteZone(zone, totalGrams);
        var free = svc.free_over_minor != null && ctx.subtotal_minor >= svc.free_over_minor;
        quotes.push({
          id:           svc.id,
          label:        svc.label,
          amount_minor: free ? 0 : raw,
          free:         free,
          jurisdiction: zone.country + (zone.state ? "/" + zone.state : "") + (zone.postal_prefix ? "/" + zone.postal_prefix : ""),
        });
      }
      return { services: quotes, total_grams: totalGrams };
    },
  };
}

function create(opts) {
  opts = opts || {};
  if (opts.adapter && opts.adapter !== "operatorTable") {
    throw new TypeError("shipping.create: unknown adapter " + JSON.stringify(opts.adapter) + " — only 'operatorTable' is supported in v1");
  }
  return operatorTable(opts);
}

module.exports = {
  create:        create,
  operatorTable: operatorTable,
};
