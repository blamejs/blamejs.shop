"use strict";
/**
 * @module shop.shippingZones
 * @title  Shipping zones — operator-defined regional rate tables
 *
 * @intro
 *   Distinct sibling of `carrierRates` (which caches live carrier-API
 *   quotes for a single parcel) and of `shipping` (which does per-order
 *   cost math at the till). A zone is the flat-rate / table-rate
 *   option an operator reaches for when carrier shopping is overkill
 *   or unwanted — domestic US flat rate, EU zone-1 table rate, APAC
 *   weight-bucket rate.
 *
 *   A zone has two operator-authored parts:
 *
 *     1. `regions` — array of `{country, region?}` entries the zone
 *        covers. Country is ISO 3166-1 alpha-2 (2 uppercase letters);
 *        region (when present) is the ISO 3166-2 subdivision code
 *        WITHOUT the country prefix (e.g. `CA` for California, `BAV`
 *        for Bavaria). A region-less entry covers the whole country.
 *        Most-specific match wins at lookup time — a `{country: "US",
 *        region: "CA"}` entry beats a `{country: "US"}` entry for a
 *        California destination.
 *
 *     2. `rates` — array of bucketed rate rows. Each row carries
 *        optional `[min_weight_grams, max_weight_grams)` half-open
 *        bounds (the weight bucket), optional `[min_order_minor,
 *        max_order_minor)` half-open bounds (the cart-value bucket),
 *        a non-negative `rate_minor`, a 3-letter ISO 4217 `currency`,
 *        and an operator-facing `service_label`. A rate carrying both
 *        kinds of bounds matches only when both the parcel weight AND
 *        the order value fall inside. A rate carrying NO bounds is the
 *        unconditional fallback (matches every shipment).
 *
 *   Lookups:
 *
 *     - `zoneForDestination({country, region?})` returns the most-
 *       specific covering zone's slug (or null). Country+region
 *       beats country-only; ties between two equally-specific zones
 *       resolve by slug ASC (deterministic).
 *
 *     - `rateFor({destination_country, destination_region?,
 *                 weight_grams, order_minor, currency})` walks every
 *       ACTIVE zone whose regions cover the destination, gathers all
 *       matching rate rows in the requested currency, and returns the
 *       list sorted by `rate_minor` ASC then `service_label` ASC.
 *       Multiple service labels (Standard / Express / Free-over-N) can
 *       all match a single shipment — the till renders them as a
 *       menu.
 *
 *   Composes:
 *     - `b.uuid`  (not exposed externally — zones key on slug, not
 *                  uuid; no random ids in the surface)
 *
 *   Surface:
 *     defineZone({ slug, title, regions, rates, active? })
 *     getZone(slug)
 *     listZones({ active_only? })
 *     updateZone(slug, patch)
 *     archiveZone(slug)
 *     rateFor({ destination_country, destination_region?,
 *               weight_grams, order_minor, currency })
 *     zoneForDestination({ country, region? })
 *
 *   Storage:
 *     - `shipping_zones` (migration `0106_shipping_zones.sql`).
 *
 * @primitive shippingZones
 * @related   shop.carrierRates, shop.shipping
 */

var MAX_SLUG_LEN          = 64;
var SLUG_RE               = /^[a-z0-9][a-z0-9_-]{0,63}$/;

var MAX_TITLE_LEN         = 200;

var MAX_REGIONS           = 1024;
var COUNTRY_RE            = /^[A-Z]{2}$/;
var REGION_RE             = /^[A-Z0-9]{1,3}$/;

var MAX_RATES             = 256;
var MAX_SERVICE_LABEL_LEN = 128;

// allow:raw-time-literal — grams (1 t), not a duration; the `* 1000` is a mass conversion
var MAX_WEIGHT_GRAMS      = 1000 * 1000;   // 1 t — generous, refuses absurd input
var MAX_ORDER_MINOR       = 1e12;          // 10 billion in the minor unit — generous

var ALLOWED_UPDATE_COLUMNS = Object.freeze([
  "title", "regions", "rates", "active",
]);

// Lazy framework handle — matches the pattern every other shop
// primitive uses; avoids the require cycle that would arise from
// importing `./index` at module-eval time.
var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ---------------------------------------------------------

function _hasControlByte(s) {
  for (var i = 0; i < s.length; i += 1) {
    var cc = s.charCodeAt(i);
    if (cc <= 0x1f || cc === 0x7f) return true;
  }
  return false;
}

function _slug(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("shippingZones: slug must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("shippingZones: slug must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "shippingZones: slug must match /^[a-z0-9][a-z0-9_-]{0,63}$/ — " +
      "lowercase alphanumerics with `_`/`-`, must not start with separator"
    );
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("shippingZones: title must be a non-empty string");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("shippingZones: title must be <= " + MAX_TITLE_LEN + " characters");
  }
  if (_hasControlByte(s)) {
    throw new TypeError("shippingZones: title must not contain control characters");
  }
  return s;
}

function _country(s, label) {
  if (typeof s !== "string" || !COUNTRY_RE.test(s)) {
    throw new TypeError(
      "shippingZones: " + label + " must be ISO 3166-1 alpha-2 (2 uppercase letters), got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _region(s, label) {
  if (s == null || s === "") return null;
  if (typeof s !== "string" || !REGION_RE.test(s)) {
    throw new TypeError(
      "shippingZones: " + label + " must match /^[A-Z0-9]{1,3}$/ — ISO 3166-2 " +
      "subdivision code without the country prefix, got " + JSON.stringify(s)
    );
  }
  return s;
}

function _regions(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TypeError("shippingZones: regions must be a non-empty array");
  }
  if (arr.length > MAX_REGIONS) {
    throw new TypeError("shippingZones: regions must be <= " + MAX_REGIONS + " entries");
  }
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var r = arr[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      throw new TypeError("shippingZones: regions[" + i + "] must be an object {country, region?}");
    }
    var country = _country(r.country, "regions[" + i + "].country");
    var region  = _region(r.region, "regions[" + i + "].region");
    var key = country + "/" + (region || "*");
    if (Object.prototype.hasOwnProperty.call(seen, key)) {
      throw new TypeError(
        "shippingZones: regions[" + i + "] duplicates an earlier (country" +
        (region ? "+region" : "") + ") entry: " + key
      );
    }
    seen[key] = true;
    out.push({ country: country, region: region });
  }
  return out;
}

function _currency(c, label) {
  if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("shippingZones: " + label + " must be 3-letter uppercase ISO 4217");
  }
  return c;
}

function _serviceLabel(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("shippingZones: rates[].service_label must be a non-empty string");
  }
  if (s.length > MAX_SERVICE_LABEL_LEN) {
    throw new TypeError("shippingZones: rates[].service_label must be <= " + MAX_SERVICE_LABEL_LEN + " characters");
  }
  if (_hasControlByte(s)) {
    throw new TypeError("shippingZones: rates[].service_label must not contain control characters");
  }
  return s;
}

function _rateMinor(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("shippingZones: rates[].rate_minor must be a non-negative integer");
  }
  return n;
}

function _weightBound(v, label) {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 0 || v > MAX_WEIGHT_GRAMS) {
    throw new TypeError(
      "shippingZones: " + label + " must be a non-negative integer <= " + MAX_WEIGHT_GRAMS + " when provided"
    );
  }
  return v;
}

function _orderBound(v, label) {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 0 || v > MAX_ORDER_MINOR) {
    throw new TypeError(
      "shippingZones: " + label + " must be a non-negative integer <= " + MAX_ORDER_MINOR + " when provided"
    );
  }
  return v;
}

function _rates(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TypeError("shippingZones: rates must be a non-empty array");
  }
  if (arr.length > MAX_RATES) {
    throw new TypeError("shippingZones: rates must be <= " + MAX_RATES + " entries");
  }
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var r = arr[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      throw new TypeError("shippingZones: rates[" + i + "] must be an object");
    }
    var minW = _weightBound(r.min_weight_grams, "rates[" + i + "].min_weight_grams");
    var maxW = _weightBound(r.max_weight_grams, "rates[" + i + "].max_weight_grams");
    if (minW != null && maxW != null && minW >= maxW) {
      throw new TypeError(
        "shippingZones: rates[" + i + "] — min_weight_grams must be strictly less than max_weight_grams"
      );
    }
    var minO = _orderBound(r.min_order_minor, "rates[" + i + "].min_order_minor");
    var maxO = _orderBound(r.max_order_minor, "rates[" + i + "].max_order_minor");
    if (minO != null && maxO != null && minO >= maxO) {
      throw new TypeError(
        "shippingZones: rates[" + i + "] — min_order_minor must be strictly less than max_order_minor"
      );
    }
    var rateMinor    = _rateMinor(r.rate_minor);
    var currency     = _currency(r.currency, "rates[" + i + "].currency");
    var serviceLabel = _serviceLabel(r.service_label);
    out.push({
      min_weight_grams: minW,
      max_weight_grams: maxW,
      min_order_minor:  minO,
      max_order_minor:  maxO,
      rate_minor:       rateMinor,
      currency:         currency,
      service_label:    serviceLabel,
    });
  }
  return out;
}

function _active(a) {
  if (typeof a !== "boolean") {
    throw new TypeError("shippingZones: active must be a boolean");
  }
  return a ? 1 : 0;
}

function _now() { return Date.now(); }

// Match-fit test for one rate row against a (weight_grams, order_minor,
// currency) lookup. `null` bounds are open on that side. The currency
// MUST match exactly — mixing USD against an EUR-priced bucket would
// silently mis-charge the operator.
function _rateMatches(rate, weightGrams, orderMinor, currency) {
  if (rate.currency !== currency) return false;
  if (rate.min_weight_grams != null && weightGrams <  rate.min_weight_grams) return false;
  if (rate.max_weight_grams != null && weightGrams >= rate.max_weight_grams) return false;
  if (rate.min_order_minor  != null && orderMinor  <  rate.min_order_minor)  return false;
  if (rate.max_order_minor  != null && orderMinor  >= rate.max_order_minor)  return false;
  return true;
}

// Specificity score for a destination match against a zone's regions:
//   2 — country + region matches exactly
//   1 — country-only entry matches (region omitted on either side)
//   0 — no entry matches
// Most-specific wins at lookup time.
function _zoneSpecificity(zoneRegions, country, region) {
  var best = 0;
  for (var i = 0; i < zoneRegions.length; i += 1) {
    var entry = zoneRegions[i];
    if (entry.country !== country) continue;
    if (entry.region == null) {
      // Country-only entry — covers every destination in that country.
      if (best < 1) best = 1;
    } else if (region != null && entry.region === region) {
      // Country + region exact — strongest match, can short-circuit.
      return 2;
    }
  }
  return best;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  function _hydrate(row) {
    if (!row) return null;
    var regions = [];
    var rates   = [];
    try { regions = JSON.parse(row.regions_json || "[]"); }
    catch (_e) { regions = []; /* drop-silent — by design; stored shape is primitive-owned */ }
    try { rates = JSON.parse(row.rates_json || "[]"); }
    catch (_e) { rates = []; /* drop-silent — by design; stored shape is primitive-owned */ }
    return {
      slug:        row.slug,
      title:       row.title,
      regions:     regions,
      rates:       rates,
      active:      Number(row.active) === 1,
      archived_at: row.archived_at == null ? null : Number(row.archived_at),
      created_at:  Number(row.created_at),
      updated_at:  Number(row.updated_at),
    };
  }

  async function _getRaw(slug) {
    var r = await query("SELECT * FROM shipping_zones WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  // Read every live (non-archived) zone into memory. Zones are read-
  // mostly with a small working set — an operator typically registers
  // 5-20 — so the lookup walks the lot in JS rather than encoding
  // region matching into SQL. `active_only` filters out paused zones.
  async function _liveZones(activeOnly) {
    var sql = "SELECT * FROM shipping_zones WHERE archived_at IS NULL";
    if (activeOnly) sql += " AND active = 1";
    sql += " ORDER BY slug ASC";
    var r = await query(sql, []);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrate(r.rows[i]));
    return out;
  }

  return {
    SLUG_RE:                SLUG_RE,
    COUNTRY_RE:             COUNTRY_RE,
    REGION_RE:              REGION_RE,
    MAX_REGIONS:            MAX_REGIONS,
    MAX_RATES:              MAX_RATES,
    MAX_WEIGHT_GRAMS:       MAX_WEIGHT_GRAMS,
    MAX_ORDER_MINOR:        MAX_ORDER_MINOR,

    // Write a zone. Re-calling with the same slug refuses — operators
    // mutating a zone go through `updateZone` so the audit trail
    // (created_at + updated_at) stays threaded by slug. Archived zones
    // also block re-defining the same slug — the archive is the
    // intentional one-way exit; rotating the same name back into
    // service would silently shadow the historical record.
    defineZone: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("shippingZones.defineZone: input object required");
      }
      var slug    = _slug(input.slug);
      var title   = _title(input.title);
      var regions = _regions(input.regions);
      var rates   = _rates(input.rates);
      // `active` defaults to true — the common case is "I've defined
      // the zone, turn it on." Operators staging a zone pass `active:
      // false` and flip later via `updateZone`.
      var active = input.active == null ? 1 : _active(input.active);

      var existing = await _getRaw(slug);
      if (existing) {
        var err = new Error(
          "shippingZones.defineZone: refused — zone '" + slug + "' already exists" +
          (existing.archived_at != null ? " (archived)" : "") +
          ". Use updateZone to mutate an existing zone, or pick a different slug"
        );
        err.code = "SHIPPING_ZONE_EXISTS";
        throw err;
      }

      var ts = _now();
      await query(
        "INSERT INTO shipping_zones " +
        "(slug, title, regions_json, rates_json, active, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
        [slug, title, JSON.stringify(regions), JSON.stringify(rates), active, ts],
      );
      return _hydrate(await _getRaw(slug));
    },

    // Read one by slug. Returns the hydrated row (regions/rates parsed
    // out of the JSON columns) or null when no such zone exists.
    // Archived zones are returned too — operator dashboards rendering
    // history want them; the lookup paths (`rateFor`, `zoneFor-
    // Destination`) filter archived rows themselves.
    getZone: async function (slug) {
      var s = _slug(slug);
      return _hydrate(await _getRaw(s));
    },

    // List zones. Default returns every non-archived zone (active +
    // paused both); `active_only: true` returns only active.
    listZones: async function (listOpts) {
      listOpts = listOpts || {};
      var activeOnly = listOpts.active_only === true;
      return _liveZones(activeOnly);
    },

    // Patch-style update — only ALLOWED_UPDATE_COLUMNS can be set.
    // slug is immutable (it's the primary key + the operator-facing
    // stable identifier; renaming would break every saved customer
    // reference). To "rename" a zone, archive the existing zone and
    // define a new one — the archived row stays in the audit history.
    //
    // Archived zones refuse all mutations — the archive is the
    // intentional one-way exit. The operator un-archives by archiving
    // their reference to the old slug and defining a fresh zone.
    updateZone: async function (slug, patch) {
      var s = _slug(slug);
      if (!patch || typeof patch !== "object") {
        throw new TypeError("shippingZones.updateZone: patch object required");
      }
      var keys = Object.keys(patch);
      if (!keys.length) {
        throw new TypeError("shippingZones.updateZone: patch must contain at least one column");
      }
      for (var i = 0; i < keys.length; i += 1) {
        if (ALLOWED_UPDATE_COLUMNS.indexOf(keys[i]) === -1) {
          throw new TypeError("shippingZones.updateZone: column '" + keys[i] + "' not updatable");
        }
      }
      var current = await _getRaw(s);
      if (!current) return null;
      if (current.archived_at != null) {
        var refused = new Error("shippingZones.updateZone: refused — zone is archived");
        refused.code = "SHIPPING_ZONE_ARCHIVED";
        throw refused;
      }

      var sets   = [];
      var params = [];
      var idx    = 1;
      function _set(col, val) {
        sets.push(col + " = ?" + idx);
        params.push(val);
        idx += 1;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "title")) {
        _set("title", _title(patch.title));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "regions")) {
        _set("regions_json", JSON.stringify(_regions(patch.regions)));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "rates")) {
        _set("rates_json", JSON.stringify(_rates(patch.rates)));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "active")) {
        _set("active", _active(patch.active));
      }
      var ts = _now();
      _set("updated_at", ts);
      params.push(s);
      var sql = "UPDATE shipping_zones SET " + sets.join(", ") + " WHERE slug = ?" + idx;
      await query(sql, params);
      return _hydrate(await _getRaw(s));
    },

    // Soft-delete — stamp archived_at + force active=0 so the zone
    // stops participating in lookups. The row stays on disk for audit
    // (region + rate snapshot at the moment of archive is preserved).
    // Idempotent — archiving an already-archived zone returns it
    // unchanged.
    archiveZone: async function (slug) {
      var s = _slug(slug);
      var current = await _getRaw(s);
      if (!current) return null;
      if (current.archived_at != null) return _hydrate(current);
      var ts = _now();
      await query(
        "UPDATE shipping_zones SET archived_at = ?1, active = 0, updated_at = ?1 WHERE slug = ?2",
        [ts, s],
      );
      return _hydrate(await _getRaw(s));
    },

    // Find the most-specific covering zone for a destination. Returns
    // the zone slug (string) or null when no active zone covers it.
    // Country+region beats country-only; ties between two equally-
    // specific zones resolve by slug ASC for determinism. Only ACTIVE
    // (active=1, archived_at IS NULL) zones participate — paused or
    // archived zones drop out of the routing pool without operator
    // scrubbing the rate tables.
    zoneForDestination: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("shippingZones.zoneForDestination: input object required");
      }
      var country = _country(input.country, "country");
      var region  = _region(input.region, "region");
      var zones = await _liveZones(true);
      var best = null;
      var bestScore = 0;
      for (var i = 0; i < zones.length; i += 1) {
        var z = zones[i];
        var score = _zoneSpecificity(z.regions, country, region);
        if (score > bestScore) {
          best = z;
          bestScore = score;
        }
        // Ties resolved by slug ASC — zones are already iterated in
        // slug order, so the first hit at a given score wins.
      }
      return best ? best.slug : null;
    },

    // Gather every rate row in the requested currency from every
    // active zone covering the destination, then return them sorted by
    // rate_minor ASC then service_label ASC. Empty array when no zone
    // covers the destination OR no rate row matches the (weight,
    // order_value, currency) tuple.
    //
    // The walk visits ALL covering zones — an operator with both a
    // "domestic-us" zone (country: US) AND a "domestic-us-ca" zone
    // (country: US, region: CA) sees rates from both for a California
    // destination, because each zone may carry a different service
    // tier (CA same-day vs nation-wide standard). The till renders the
    // sorted list as a menu.
    //
    // Each returned row carries the originating `zone_slug` so the
    // till can attribute the rate back to its source zone.
    rateFor: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("shippingZones.rateFor: input object required");
      }
      var country  = _country(input.destination_country, "destination_country");
      var region   = _region(input.destination_region, "destination_region");
      if (!Number.isInteger(input.weight_grams) || input.weight_grams < 0 || input.weight_grams > MAX_WEIGHT_GRAMS) {
        throw new TypeError(
          "shippingZones.rateFor: weight_grams must be a non-negative integer <= " + MAX_WEIGHT_GRAMS
        );
      }
      var weightGrams = input.weight_grams;
      if (!Number.isInteger(input.order_minor) || input.order_minor < 0 || input.order_minor > MAX_ORDER_MINOR) {
        throw new TypeError(
          "shippingZones.rateFor: order_minor must be a non-negative integer <= " + MAX_ORDER_MINOR
        );
      }
      var orderMinor = input.order_minor;
      var currency   = _currency(input.currency, "currency");

      var zones = await _liveZones(true);
      var out = [];
      for (var i = 0; i < zones.length; i += 1) {
        var z = zones[i];
        var specificity = _zoneSpecificity(z.regions, country, region);
        if (specificity === 0) continue;
        for (var j = 0; j < z.rates.length; j += 1) {
          var r = z.rates[j];
          if (!_rateMatches(r, weightGrams, orderMinor, currency)) continue;
          out.push({
            zone_slug:        z.slug,
            rate_minor:       r.rate_minor,
            currency:         r.currency,
            service_label:    r.service_label,
            min_weight_grams: r.min_weight_grams,
            max_weight_grams: r.max_weight_grams,
            min_order_minor:  r.min_order_minor,
            max_order_minor:  r.max_order_minor,
          });
        }
      }
      out.sort(function (a, b) {
        if (a.rate_minor !== b.rate_minor) return a.rate_minor - b.rate_minor;
        if (a.service_label < b.service_label) return -1;
        if (a.service_label > b.service_label) return 1;
        if (a.zone_slug < b.zone_slug) return -1;
        if (a.zone_slug > b.zone_slug) return 1;
        return 0;
      });
      return out;
    },
  };
}

module.exports = {
  create:                  create,
  SLUG_RE:                 SLUG_RE,
  COUNTRY_RE:              COUNTRY_RE,
  REGION_RE:               REGION_RE,
  MAX_REGIONS:             MAX_REGIONS,
  MAX_RATES:               MAX_RATES,
  MAX_WEIGHT_GRAMS:        MAX_WEIGHT_GRAMS,
  MAX_ORDER_MINOR:         MAX_ORDER_MINOR,
};
