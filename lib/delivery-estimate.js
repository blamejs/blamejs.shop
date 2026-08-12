"use strict";
/**
 * @module shop.deliveryEstimate
 * @title  Delivery-estimate primitive — PDP + cart "Get it by Thursday"
 *         window calculator
 *
 * @intro
 *   A customer landing on a product detail page or opening the cart
 *   wants one answer: "If I order now, when will it arrive?" The
 *   storefront composes the answer out of four operator-author
 *   tables:
 *
 *     1. Carrier transits — for each (from_zone -> to_zone, carrier,
 *        service_level) tuple, the carrier-declared transit_days
 *        budget (business days). Operators author this from the
 *        carrier's published service guide; the primitive walks the
 *        rows when an estimate request lands.
 *
 *     2. Origin cutoffs — per inventory-location, the daily local-
 *        time cutoff after which today's orders ship tomorrow. The
 *        primitive resolves the request's `now` against the cutoff
 *        in the origin's IANA timezone. A request before cutoff
 *        ships today (a business day); on / after cutoff rolls to
 *        the next business day at the origin.
 *
 *     3. Holidays — per-region calendar dates (YYYY-MM-DD) that drop
 *        out of the business-day count for that region. The primitive
 *        applies the origin region's holidays to the ship date and
 *        the destination region's holidays to the delivery transit.
 *        The author registers a region's observed holidays once a
 *        year and the framework skips them automatically.
 *
 *     4. Postal-prefix -> zone mappings — for destination_postal
 *        lookup. Operators author one row per prefix-bucket they
 *        care about (`"902"` -> `"us-west"`, `"100"` -> `"us-east"`).
 *        Longest-prefix wins. A request whose destination_postal
 *        doesn't match any prefix in its country falls through with
 *        a typed reason — the storefront renders a generic transit-
 *        time bracket rather than guessing.
 *
 *   The math is calendar-day-deterministic. `estimate` returns
 *   {ship_by_date, est_min_delivery_date, est_max_delivery_date,
 *   service_levels: [...]} where each service-level row carries its
 *   own ship_by + deliver_by + business_days count. Dates are
 *   YYYY-MM-DD strings in the origin's timezone so the storefront
 *   renders them without re-doing the timezone math.
 *
 *   Composes:
 *     - `b.uuid.v7` — id mint for carrier_transits + holidays
 *     - `b.guardUuid` — id-shape gate on archive
 *     - Optional `inventoryLocations` handle to resolve a default
 *       `origin_location` when the caller omits it
 *     - Optional `shippingZones` handle to resolve a
 *       (destination_country, destination_region) -> zone slug when
 *       the operator authored zones but skipped postal-prefix rows
 *
 *   Surface:
 *     defineCarrierTransit({ from_zone, to_zone, carrier,
 *                            service_level, transit_days })
 *     defineCutoff({ origin_location, daily_cutoff_local_time,
 *                    timezone })
 *     defineHoliday({ region, date, name })
 *     definePostalZone({ country, postal_prefix, zone })
 *     estimate({ origin_location?, destination_postal,
 *                destination_country, destination_region?,
 *                weight_grams?, requested_service_level?, now? })
 *     estimateForCart({ cart, destination, now? })
 *     listTransits({ carrier? })
 *     listCutoffs()
 *     listHolidays({ region?, from?, to? })
 *     listPostalZones({ country? })
 *     archiveTransit(transit_id)
 *     archiveHoliday(holiday_id)
 *
 *   Storage:
 *     - `carrier_transits`   (migration `0117_delivery_estimate.sql`)
 *     - `shipping_cutoffs`   (migration `0117_delivery_estimate.sql`)
 *     - `shipping_holidays`  (migration `0117_delivery_estimate.sql`)
 *     - `delivery_postal_zones` (migration `0117_delivery_estimate.sql`)
 *
 * @primitive deliveryEstimate
 * @related   b.uuid, shop.shippingZones, shop.carrierRates,
 *            shop.inventoryLocations
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var MAX_ZONE_LEN          = 64;
var ZONE_RE               = /^[a-z0-9][a-z0-9_-]{0,63}$/;

var CARRIERS              = Object.freeze(["ups", "fedex", "usps", "dhl", "flat_rate", "custom"]);

var MAX_SERVICE_LEVEL_LEN = 64;
var SERVICE_LEVEL_RE      = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

var MAX_TRANSIT_DAYS      = 365;

var MAX_LOCATION_LEN      = 80;
var LOCATION_RE           = /^[a-z0-9][a-z0-9_-]{0,79}$/;

var MAX_REGION_LEN        = 16;
// region is operator-author shorthand (`us`, `us-ca`, `gb`, `eu`); kept
// tight enough to refuse control bytes / arbitrary input but loose
// enough to admit the shapes the caller already carries in cart /
// customer state.
var REGION_RE             = /^[a-z0-9][a-z0-9_-]{0,15}$/;

var DATE_RE               = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

var TIME_RE               = /^([01]\d|2[0-3]):[0-5]\d$/;

// IANA TZ name — area/city plus an optional second segment (Indian/Maldives,
// America/Argentina/Buenos_Aires). Refuses control bytes + plain offsets
// like "+0500" so the framework's Date.toLocaleString call doesn't
// silently coerce to UTC when handed garbage.
var TZ_RE                 = /^[A-Z][A-Za-z]+\/[A-Z][A-Za-z_]+(\/[A-Z][A-Za-z_]+)?$/;

var MAX_NAME_LEN          = 200;

var MAX_POSTAL_PREFIX_LEN = 16;
var POSTAL_PREFIX_RE      = /^[A-Za-z0-9][A-Za-z0-9 -]{0,15}$/;
var MAX_POSTAL_LEN        = 16;
var POSTAL_RE             = /^[A-Za-z0-9][A-Za-z0-9 -]{0,15}$/;

var COUNTRY_RE            = /^[A-Z]{2}$/;

var MAX_WEIGHT_GRAMS      = 1000 * 1000; // allow:raw-time-literal — grams (1000 kg), not a duration

var DAY_MS                = b.constants.TIME.days(1);

// ---- validators ---------------------------------------------------------

// C0 + DEL, tab included. `allowHt: false` is load-bearing: the predicate
// permits ASCII HT by default (it is folding whitespace in a header), and
// these are single-line operator fields where a tab has no business.
function _hasControlByte(s) {
  return b.structuredFields.containsControlBytes(s, { allowHt: false });
}

function _zone(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("deliveryEstimate: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_ZONE_LEN) {
    throw new TypeError("deliveryEstimate: " + label + " must be <= " + MAX_ZONE_LEN + " characters");
  }
  if (!ZONE_RE.test(s)) {
    throw new TypeError(
      "deliveryEstimate: " + label + " must match /^[a-z0-9][a-z0-9_-]{0,63}$/"
    );
  }
  return s;
}

function _carrier(c) {
  if (typeof c !== "string" || CARRIERS.indexOf(c) === -1) {
    throw new TypeError("deliveryEstimate: carrier must be one of " + CARRIERS.join(", "));
  }
  return c;
}

function _serviceLevel(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("deliveryEstimate: service_level must be a non-empty string");
  }
  if (s.length > MAX_SERVICE_LEVEL_LEN) {
    throw new TypeError("deliveryEstimate: service_level must be <= " + MAX_SERVICE_LEVEL_LEN + " characters");
  }
  if (!SERVICE_LEVEL_RE.test(s)) {
    throw new TypeError(
      "deliveryEstimate: service_level must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/"
    );
  }
  return s;
}

function _transitDays(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_TRANSIT_DAYS) {
    throw new TypeError(
      "deliveryEstimate: transit_days must be an integer 0.." + MAX_TRANSIT_DAYS
    );
  }
  return n;
}

function _location(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("deliveryEstimate: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_LOCATION_LEN) {
    throw new TypeError("deliveryEstimate: " + label + " must be <= " + MAX_LOCATION_LEN + " characters");
  }
  if (!LOCATION_RE.test(s)) {
    throw new TypeError(
      "deliveryEstimate: " + label + " must match /^[a-z0-9][a-z0-9_-]{0,79}$/"
    );
  }
  return s;
}

function _region(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("deliveryEstimate: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_REGION_LEN) {
    throw new TypeError("deliveryEstimate: " + label + " must be <= " + MAX_REGION_LEN + " characters");
  }
  if (!REGION_RE.test(s)) {
    throw new TypeError(
      "deliveryEstimate: " + label + " must match /^[a-z0-9][a-z0-9_-]{0,15}$/"
    );
  }
  return s;
}

function _date(s, label) {
  if (typeof s !== "string" || !DATE_RE.test(s)) {
    throw new TypeError(
      "deliveryEstimate: " + label + " must be a YYYY-MM-DD string"
    );
  }
  // Verify the date actually exists — DATE_RE admits 2026-02-30 etc.
  // _parseYMD throws when the constructed Date doesn't round-trip.
  _parseYMD(s, label);
  return s;
}

function _time(s, label) {
  if (typeof s !== "string" || !TIME_RE.test(s)) {
    throw new TypeError(
      "deliveryEstimate: " + label + " must be a HH:MM 24-hour string"
    );
  }
  return s;
}

function _tz(s, label) {
  if (typeof s !== "string" || !TZ_RE.test(s)) {
    throw new TypeError(
      "deliveryEstimate: " + label + " must be an IANA timezone name (Area/City)"
    );
  }
  // Validate against Intl — TZ_RE is a syntactic gate, Intl is the
  // semantic gate. An invalid zone (e.g. "Made/Up_Place") throws here
  // so a typo at config time surfaces loud.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s });
  } catch (_e) {
    throw new TypeError(
      "deliveryEstimate: " + label + " is not a known IANA timezone (got " + JSON.stringify(s) + ")"
    );
  }
  return s;
}

function _name(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("deliveryEstimate: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_NAME_LEN) {
    throw new TypeError("deliveryEstimate: " + label + " must be <= " + MAX_NAME_LEN + " characters");
  }
  if (_hasControlByte(s)) {
    throw new TypeError("deliveryEstimate: " + label + " must not contain control characters");
  }
  return s;
}

function _country(s, label) {
  if (typeof s !== "string" || !COUNTRY_RE.test(s)) {
    throw new TypeError(
      "deliveryEstimate: " + label + " must be ISO 3166-1 alpha-2 (2 uppercase letters)"
    );
  }
  return s;
}

function _postalPrefix(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("deliveryEstimate: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_POSTAL_PREFIX_LEN) {
    throw new TypeError("deliveryEstimate: " + label + " must be <= " + MAX_POSTAL_PREFIX_LEN + " characters");
  }
  if (!POSTAL_PREFIX_RE.test(s)) {
    throw new TypeError(
      "deliveryEstimate: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9 -]{0,15}$/"
    );
  }
  return s;
}

function _postal(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("deliveryEstimate: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_POSTAL_LEN) {
    throw new TypeError("deliveryEstimate: " + label + " must be <= " + MAX_POSTAL_LEN + " characters");
  }
  if (!POSTAL_RE.test(s)) {
    throw new TypeError(
      "deliveryEstimate: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9 -]{0,15}$/"
    );
  }
  return s;
}

function _weightGrams(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0 || n > MAX_WEIGHT_GRAMS) {
    throw new TypeError(
      "deliveryEstimate: " + label + " must be a non-negative integer <= " + MAX_WEIGHT_GRAMS
    );
  }
  return n;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("deliveryEstimate: " + label + " must be a positive integer epoch-ms");
  }
  return n;
}

function _now() { return Date.now(); }

// ---- date math ----------------------------------------------------------
//
// All math is "calendar day" against an IANA timezone. The hot path uses
// Intl.DateTimeFormat to decompose an epoch-ms into the wall-clock parts
// for the origin's timezone, then walks day-by-day forward applying
// weekend + holiday skips. The arithmetic is integer days; no floats,
// no DST drift (Intl handles the wall-clock conversion).

function _parseYMD(s, label) {
  var y = Number(s.slice(0, 4));
  var mo = Number(s.slice(5, 7));
  var d = Number(s.slice(8, 10));
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) {
    throw new TypeError("deliveryEstimate: " + label + " — invalid YYYY-MM-DD digits");
  }
  // Round-trip via Date.UTC; if month or day overflow (e.g. Feb 30 ->
  // Mar 02) the constructed parts won't match the input.
  var ts = Date.UTC(y, mo - 1, d);
  var dt = new Date(ts);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== (mo - 1) || dt.getUTCDate() !== d) {
    throw new TypeError("deliveryEstimate: " + label + " — not a real calendar date");
  }
  return { y: y, m: mo, d: d, ts: ts };
}

function _formatYMD(parts) {
  var y = String(parts.y);
  var m = parts.m < 10 ? "0" + parts.m : String(parts.m);
  var d = parts.d < 10 ? "0" + parts.d : String(parts.d);
  return y + "-" + m + "-" + d;
}

// Decompose an epoch-ms into {y, m, d, hh, mm, weekday(0..6 Sun..Sat)}
// at the requested IANA timezone. Uses Intl.DateTimeFormat parts so the
// result is DST-correct without manual offset bookkeeping.
function _wallClockIn(tz, epochMs) {
  var fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
    weekday:  "short",
  });
  var parts = fmt.formatToParts(new Date(epochMs));
  var out = { y: 0, m: 0, d: 0, hh: 0, mm: 0, weekday: 0 };
  for (var i = 0; i < parts.length; i += 1) {
    var p = parts[i];
    if (p.type === "year")     out.y  = Number(p.value);
    if (p.type === "month")    out.m  = Number(p.value);
    if (p.type === "day")      out.d  = Number(p.value);
    if (p.type === "hour")     out.hh = Number(p.value) === 24 ? 0 : Number(p.value);
    if (p.type === "minute")   out.mm = Number(p.value);
    if (p.type === "weekday") {
      // Sun, Mon, Tue, Wed, Thu, Fri, Sat -> 0..6
      var map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      out.weekday = map[p.value] != null ? map[p.value] : 0;
    }
  }
  return out;
}

// Add `n` calendar days to {y, m, d} parts. Returns fresh parts at the
// resulting wall-clock date. Walks via Date.UTC so month / year roll
// over naturally.
function _addDays(parts, n) {
  var ts = Date.UTC(parts.y, parts.m - 1, parts.d) + n * DAY_MS;
  var dt = new Date(ts);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
  };
}

// JS Date.UTC weekday is Sun=0..Sat=6 — same convention as the Intl
// `weekday: short` map above so the two clocks agree.
function _weekdayOfYMD(parts) {
  var ts = Date.UTC(parts.y, parts.m - 1, parts.d);
  return new Date(ts).getUTCDay();
}

function _isWeekend(parts) {
  var wd = _weekdayOfYMD(parts);
  return wd === 0 || wd === 6;
}

// Step `parts` forward by `n` business days, skipping weekends and any
// date present in `holidaySet` (a Set of YYYY-MM-DD strings). `n` is
// non-negative; 0 advances to the next business day only if `parts`
// itself lands on a non-business day (so the ship date math can pre-
// roll a Saturday cutoff to Monday before adding transit).
function _addBusinessDays(parts, n, holidaySet) {
  // Pre-roll: if start is non-business, move forward to the next
  // business day before counting transit. This is how carriers price
  // weekend-handed parcels.
  var cur = { y: parts.y, m: parts.m, d: parts.d };
  while (_isNonBusiness(cur, holidaySet)) {
    cur = _addDays(cur, 1);
  }
  for (var i = 0; i < n; i += 1) {
    cur = _addDays(cur, 1);
    while (_isNonBusiness(cur, holidaySet)) {
      cur = _addDays(cur, 1);
    }
  }
  return cur;
}

function _isNonBusiness(parts, holidaySet) {
  if (_isWeekend(parts)) return true;
  if (holidaySet && holidaySet[_formatYMD(parts)]) return true;
  return false;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var inventoryLocations = opts.inventoryLocations || null;
  var shippingZones      = opts.shippingZones || null;

  function _hydrateTransit(row) {
    if (!row) return null;
    return {
      id:            row.id,
      from_zone:     row.from_zone,
      to_zone:       row.to_zone,
      carrier:       row.carrier,
      service_level: row.service_level,
      transit_days:  Number(row.transit_days),
      archived_at:   row.archived_at == null ? null : Number(row.archived_at),
      created_at:    Number(row.created_at),
      updated_at:    Number(row.updated_at),
    };
  }

  function _hydrateCutoff(row) {
    if (!row) return null;
    return {
      origin_location:         row.origin_location,
      daily_cutoff_local_time: row.daily_cutoff_local_time,
      timezone:                row.timezone,
      created_at:              Number(row.created_at),
      updated_at:              Number(row.updated_at),
    };
  }

  function _hydrateHoliday(row) {
    if (!row) return null;
    return {
      id:          row.id,
      region:      row.region,
      date:        row.date,
      name:        row.name,
      archived_at: row.archived_at == null ? null : Number(row.archived_at),
      created_at:  Number(row.created_at),
    };
  }

  function _hydratePostalZone(row) {
    if (!row) return null;
    return {
      country:       row.country,
      postal_prefix: row.postal_prefix,
      zone:          row.zone,
      created_at:    Number(row.created_at),
      updated_at:    Number(row.updated_at),
    };
  }

  // Read every live transit row that matches the requested zone pair
  // (and optional service_level). Archived rows drop out.
  async function _liveTransitsFor(fromZone, toZone, serviceLevel) {
    var sql = "SELECT * FROM carrier_transits WHERE archived_at IS NULL " +
              "AND from_zone = ?1 AND to_zone = ?2";
    var params = [fromZone, toZone];
    if (serviceLevel != null) {
      sql += " AND service_level = ?3";
      params.push(serviceLevel);
    }
    sql += " ORDER BY transit_days ASC, carrier ASC, service_level ASC, id ASC";
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateTransit(r.rows[i]));
    return out;
  }

  async function _holidaysForRegion(region) {
    var r = await query(
      "SELECT date FROM shipping_holidays WHERE region = ?1 AND archived_at IS NULL",
      [region],
    );
    var set = {};
    for (var i = 0; i < r.rows.length; i += 1) set[r.rows[i].date] = true;
    return set;
  }

  async function _resolvePostalToZone(country, postal) {
    // Longest postal_prefix match wins. The table is small (one row
    // per prefix-bucket the operator cares about) so the walk is fine
    // in JS — ORDER BY length(postal_prefix) DESC keeps SQL portable.
    var r = await query(
      "SELECT * FROM delivery_postal_zones WHERE country = ?1 " +
      "ORDER BY length(postal_prefix) DESC, postal_prefix ASC",
      [country],
    );
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      if (postal.indexOf(row.postal_prefix) === 0) return row.zone;
    }
    return null;
  }

  return {
    CARRIERS:           CARRIERS,
    MAX_TRANSIT_DAYS:   MAX_TRANSIT_DAYS,
    MAX_WEIGHT_GRAMS:   MAX_WEIGHT_GRAMS,
    ZONE_RE:            ZONE_RE,
    DATE_RE:            DATE_RE,
    TIME_RE:            TIME_RE,
    COUNTRY_RE:         COUNTRY_RE,

    // Register a carrier transit row. The UNIQUE
    // (from_zone, to_zone, carrier, service_level) constraint dedups
    // — re-calling with the same tuple refreshes transit_days in
    // place rather than stacking duplicates. Operators rotating a
    // service-level offering call defineCarrierTransit again with
    // the fresh number; the row id stays stable so dashboards
    // threaded by id don't churn.
    defineCarrierTransit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("deliveryEstimate.defineCarrierTransit: input object required");
      }
      var fromZone     = _zone(input.from_zone, "from_zone");
      var toZone       = _zone(input.to_zone,   "to_zone");
      var carrier      = _carrier(input.carrier);
      var serviceLevel = _serviceLevel(input.service_level);
      var transitDays  = _transitDays(input.transit_days);

      var ts = _now();
      var existing = (await query(
        "SELECT id, created_at FROM carrier_transits " +
        "WHERE from_zone = ?1 AND to_zone = ?2 AND carrier = ?3 AND service_level = ?4",
        [fromZone, toZone, carrier, serviceLevel],
      )).rows[0];
      var id        = existing ? existing.id : b.uuid.v7();
      var createdAt = existing ? Number(existing.created_at) : ts;

      await query(
        "INSERT INTO carrier_transits " +
        "(id, from_zone, to_zone, carrier, service_level, transit_days, " +
        " archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8) " +
        "ON CONFLICT(from_zone, to_zone, carrier, service_level) DO UPDATE SET " +
        "  transit_days = excluded.transit_days, " +
        "  archived_at  = NULL, " +
        "  updated_at   = excluded.updated_at",
        [id, fromZone, toZone, carrier, serviceLevel, transitDays, createdAt, ts],
      );
      var r = await query(
        "SELECT * FROM carrier_transits WHERE from_zone = ?1 AND to_zone = ?2 " +
        "AND carrier = ?3 AND service_level = ?4",
        [fromZone, toZone, carrier, serviceLevel],
      );
      return _hydrateTransit(r.rows[0]);
    },

    // Upsert a cutoff per origin location. PK is origin_location —
    // each location has exactly one cutoff (operators wanting time-
    // band cutoffs author multiple locations rather than overloading
    // one). Re-calling rotates the cutoff time / timezone in place.
    defineCutoff: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("deliveryEstimate.defineCutoff: input object required");
      }
      var origin   = _location(input.origin_location, "origin_location");
      var time     = _time(input.daily_cutoff_local_time, "daily_cutoff_local_time");
      var timezone = _tz(input.timezone, "timezone");

      var ts = _now();
      var existing = (await query(
        "SELECT created_at FROM shipping_cutoffs WHERE origin_location = ?1",
        [origin],
      )).rows[0];
      var createdAt = existing ? Number(existing.created_at) : ts;

      await query(
        "INSERT INTO shipping_cutoffs " +
        "(origin_location, daily_cutoff_local_time, timezone, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(origin_location) DO UPDATE SET " +
        "  daily_cutoff_local_time = excluded.daily_cutoff_local_time, " +
        "  timezone                = excluded.timezone, " +
        "  updated_at              = excluded.updated_at",
        [origin, time, timezone, createdAt, ts],
      );
      var r = await query(
        "SELECT * FROM shipping_cutoffs WHERE origin_location = ?1",
        [origin],
      );
      return _hydrateCutoff(r.rows[0]);
    },

    // Register one observed holiday per (region, date). Repeating
    // the same (region, date) refreshes the name in place — operators
    // re-loading the year's calendar don't churn ids. Each row carries
    // its own uuid so an archive sweep can target a single holiday
    // without scrubbing the whole region's set.
    defineHoliday: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("deliveryEstimate.defineHoliday: input object required");
      }
      var region = _region(input.region, "region");
      var date   = _date(input.date, "date");
      var name   = _name(input.name, "name");

      var ts = _now();
      var existing = (await query(
        "SELECT id, created_at FROM shipping_holidays " +
        "WHERE region = ?1 AND date = ?2",
        [region, date],
      )).rows[0];
      var id        = existing ? existing.id : b.uuid.v7();
      var createdAt = existing ? Number(existing.created_at) : ts;

      await query(
        "INSERT INTO shipping_holidays " +
        "(id, region, date, name, archived_at, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, NULL, ?5) " +
        "ON CONFLICT(region, date) DO UPDATE SET " +
        "  name        = excluded.name, " +
        "  archived_at = NULL",
        [id, region, date, name, createdAt],
      );
      var r = await query(
        "SELECT * FROM shipping_holidays WHERE region = ?1 AND date = ?2",
        [region, date],
      );
      return _hydrateHoliday(r.rows[0]);
    },

    // Operator-author postal-prefix -> zone mapping. The PK is
    // (country, postal_prefix); repeating refreshes the zone slug
    // in place. Longest-prefix wins at lookup time, so the operator
    // pads in finer-grained rows over time without scrubbing the
    // coarse-grained fallback.
    definePostalZone: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("deliveryEstimate.definePostalZone: input object required");
      }
      var country = _country(input.country, "country");
      var prefix  = _postalPrefix(input.postal_prefix, "postal_prefix");
      var zone    = _zone(input.zone, "zone");

      var ts = _now();
      var existing = (await query(
        "SELECT created_at FROM delivery_postal_zones " +
        "WHERE country = ?1 AND postal_prefix = ?2",
        [country, prefix],
      )).rows[0];
      var createdAt = existing ? Number(existing.created_at) : ts;

      await query(
        "INSERT INTO delivery_postal_zones " +
        "(country, postal_prefix, zone, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5) " +
        "ON CONFLICT(country, postal_prefix) DO UPDATE SET " +
        "  zone       = excluded.zone, " +
        "  updated_at = excluded.updated_at",
        [country, prefix, zone, createdAt, ts],
      );
      var r = await query(
        "SELECT * FROM delivery_postal_zones WHERE country = ?1 AND postal_prefix = ?2",
        [country, prefix],
      );
      return _hydratePostalZone(r.rows[0]);
    },

    // Estimate the delivery window for a single destination. Returns
    //
    //   {
    //     ok:                   bool,
    //     reason?:              string,         // when !ok
    //     origin_location:      string,
    //     origin_zone:          string,
    //     destination_zone:     string,
    //     ship_by_date:         "YYYY-MM-DD",
    //     est_min_delivery_date:"YYYY-MM-DD",
    //     est_max_delivery_date:"YYYY-MM-DD",
    //     service_levels: [
    //       { code, label, carrier, ship_by, deliver_by, business_days }
    //     ]
    //   }
    //
    // `ship_by_date` is the date today's order will physically leave
    // the origin (today when `now` is before cutoff and today is a
    // business day; the next business day otherwise). Each service-
    // level row carries its own `deliver_by` after applying transit
    // business-days from `ship_by` against the destination region's
    // holidays + weekends.
    //
    // When the destination_postal doesn't resolve to a zone (no
    // matching postal-prefix row in the destination country), the
    // result carries `ok: false, reason: "no_destination_zone"` so
    // the storefront can fall back to a generic transit-time bracket
    // instead of guessing.
    estimate: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("deliveryEstimate.estimate: input object required");
      }
      var destCountry  = _country(input.destination_country, "destination_country");
      var destPostal   = _postal(input.destination_postal, "destination_postal");
      var destRegion   = null;
      if (input.destination_region != null) {
        destRegion = _region(input.destination_region, "destination_region");
      }
      var requestedSvc = null;
      if (input.requested_service_level != null) {
        requestedSvc = _serviceLevel(input.requested_service_level);
      }
      _weightGrams(input.weight_grams, "weight_grams");
      var now = input.now == null ? _now() : _epochMs(input.now, "now");

      // Resolve origin_location — explicit > inventoryLocations.default()
      // > refuse.
      var origin = null;
      if (input.origin_location != null) {
        origin = _location(input.origin_location, "origin_location");
      } else if (inventoryLocations && typeof inventoryLocations.defaultLocation === "function") {
        var def = await inventoryLocations.defaultLocation();
        if (def && typeof def === "object" && typeof def.slug === "string") {
          origin = _location(def.slug, "inventoryLocations.defaultLocation().slug");
        }
      }
      if (!origin) {
        throw new TypeError(
          "deliveryEstimate.estimate: origin_location required " +
          "(pass explicitly OR wire inventoryLocations with a defaultLocation())"
        );
      }

      // Resolve cutoff for the origin. Without a cutoff row the
      // primitive refuses — every estimate is timezone-dependent, no
      // implicit default exists. The error is config-time-style: it
      // surfaces at the first estimate against a fresh origin so the
      // operator gets a loud "register a cutoff for this location."
      var cutoffRow = (await query(
        "SELECT * FROM shipping_cutoffs WHERE origin_location = ?1",
        [origin],
      )).rows[0];
      if (!cutoffRow) {
        throw new TypeError(
          "deliveryEstimate.estimate: no shipping_cutoffs row for origin_location '" + origin +
          "' — call defineCutoff first"
        );
      }
      var cutoff = _hydrateCutoff(cutoffRow);

      // Resolve destination_zone. Postal-prefix table is the primary
      // lookup; when shippingZones is wired AND the postal table
      // misses, fall back to the country+region zone-router.
      var destZone = await _resolvePostalToZone(destCountry, destPostal);
      if (!destZone && shippingZones && typeof shippingZones.zoneForDestination === "function") {
        destZone = await shippingZones.zoneForDestination({
          country: destCountry,
          region:  destRegion ? destRegion.toUpperCase() : null,
        });
      }
      if (!destZone) {
        return {
          ok:               false,
          reason:           "no_destination_zone",
          origin_location:  origin,
          origin_zone:      null,
          destination_zone: null,
          ship_by_date:     null,
          est_min_delivery_date: null,
          est_max_delivery_date: null,
          service_levels:   [],
        };
      }

      // Resolve origin zone via the same postal-zone lookup keyed on
      // the origin location's slug treated as its own zone (operators
      // typically register `defineCarrierTransit({from_zone: "<origin>",
      // ...})`). The convention is: when no separate origin_zone is
      // registered, use the origin_location as the from_zone.
      var originZone = origin;

      // Compute ship_by_date — the calendar day the parcel physically
      // leaves the origin. If `now` is before today's cutoff in the
      // origin TZ AND today is a business day, ship today; else push
      // to the next origin-region business day.
      var nowWall   = _wallClockIn(cutoff.timezone, now);
      var cutoffHH  = Number(cutoff.daily_cutoff_local_time.slice(0, 2));
      var cutoffMM  = Number(cutoff.daily_cutoff_local_time.slice(3, 5));
      var beforeCut = nowWall.hh < cutoffHH || (nowWall.hh === cutoffHH && nowWall.mm < cutoffMM);

      // Origin holidays — keyed by the origin's region. The operator
      // either passes an explicit `origin_region` via inventoryLocations
      // (when wired) or the framework reads the country halves of
      // origin_zone slugs by convention; in the absence of either, the
      // origin region defaults to a globally empty set (no holiday
      // skip on the ship side). Destination holidays follow the same
      // pattern, keyed by `destination_country` (default) OR an explicit
      // override.
      //
      // The operator-facing knob is `defineHoliday({region: <slug>})`:
      // they register against whatever region key matches the location's
      // documented region.
      var originRegion = await _resolveOriginRegion(origin);
      var destRegionKey = destRegion ? destRegion : destCountry.toLowerCase();
      var originHolidays = originRegion ? await _holidaysForRegion(originRegion) : {};
      var destHolidays   = await _holidaysForRegion(destRegionKey);

      var shipBy = { y: nowWall.y, m: nowWall.m, d: nowWall.d };
      if (!beforeCut) {
        // On or after cutoff — push one calendar day before applying
        // the business-day roll. Without the +1 step, a Mon-1pm
        // request with a noon cutoff would re-land on Mon after the
        // weekend skip (which does nothing on a weekday).
        shipBy = _addDays(shipBy, 1);
      }
      shipBy = _addBusinessDays(shipBy, 0, originHolidays);
      var shipByStr = _formatYMD(shipBy);

      // Transit rows for the (origin_zone, dest_zone) pair. Filter by
      // requested_service_level when supplied; the result is the menu
      // of service levels the storefront renders.
      var transits = await _liveTransitsFor(originZone, destZone, requestedSvc);
      var serviceLevels = [];
      var minDeliver = null;
      var maxDeliver = null;
      for (var i = 0; i < transits.length; i += 1) {
        var t = transits[i];
        var deliverParts = _addBusinessDays(shipBy, t.transit_days, destHolidays);
        var deliverStr   = _formatYMD(deliverParts);
        serviceLevels.push({
          code:           t.service_level,
          label:          t.carrier + " " + t.service_level,
          carrier:        t.carrier,
          ship_by:        shipByStr,
          deliver_by:     deliverStr,
          business_days:  t.transit_days,
        });
        var deliverTs = Date.UTC(deliverParts.y, deliverParts.m - 1, deliverParts.d);
        if (minDeliver == null || deliverTs < minDeliver.ts) minDeliver = { ts: deliverTs, str: deliverStr };
        if (maxDeliver == null || deliverTs > maxDeliver.ts) maxDeliver = { ts: deliverTs, str: deliverStr };
      }

      return {
        ok:                    serviceLevels.length > 0,
        reason:                serviceLevels.length === 0 ? "no_transit_rows" : null,
        origin_location:       origin,
        origin_zone:           originZone,
        destination_zone:      destZone,
        ship_by_date:          shipByStr,
        est_min_delivery_date: minDeliver ? minDeliver.str : null,
        est_max_delivery_date: maxDeliver ? maxDeliver.str : null,
        service_levels:        serviceLevels,
      };
    },

    // Per-line cart estimates. `cart.lines` is an array; each line
    // carries an optional `origin_location` (split-shipment case) and
    // weight_grams. The result mirrors the line shape with an
    // `estimate` field per line; the cart-level fields are the
    // intersection (max of mins, max of maxes) so the storefront can
    // render a "all items by ___" summary.
    estimateForCart: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("deliveryEstimate.estimateForCart: input object required");
      }
      var cart = input.cart;
      if (!cart || typeof cart !== "object" || !Array.isArray(cart.lines)) {
        throw new TypeError("deliveryEstimate.estimateForCart: cart.lines must be an array");
      }
      if (!input.destination || typeof input.destination !== "object") {
        throw new TypeError("deliveryEstimate.estimateForCart: destination object required");
      }
      var dest = input.destination;
      var now  = input.now == null ? _now() : _epochMs(input.now, "now");

      var perLine = [];
      var slowestMin = null;
      var slowestMax = null;
      var anyMissing = false;
      for (var i = 0; i < cart.lines.length; i += 1) {
        var line = cart.lines[i];
        if (!line || typeof line !== "object") {
          throw new TypeError("deliveryEstimate.estimateForCart: cart.lines[" + i + "] must be an object");
        }
        var est = await this.estimate({
          origin_location:         line.origin_location,
          destination_postal:      dest.postal,
          destination_country:     dest.country,
          destination_region:      dest.region,
          weight_grams:            line.weight_grams,
          requested_service_level: input.requested_service_level,
          now:                     now,
        });
        perLine.push({ line_id: line.id, estimate: est });
        if (!est.ok) { anyMissing = true; continue; }
        if (slowestMin == null || est.est_min_delivery_date > slowestMin) slowestMin = est.est_min_delivery_date;
        if (slowestMax == null || est.est_max_delivery_date > slowestMax) slowestMax = est.est_max_delivery_date;
      }
      return {
        ok:                    !anyMissing && perLine.length > 0,
        reason:                anyMissing ? "line_unresolved" : (perLine.length === 0 ? "empty_cart" : null),
        cart_min_delivery_date: slowestMin,
        cart_max_delivery_date: slowestMax,
        lines:                 perLine,
      };
    },

    // Operator dashboards. Filter by carrier when supplied; otherwise
    // returns every live transit row in (from_zone, to_zone,
    // transit_days, carrier, service_level) order so the result is
    // dashboard-renderable as-is.
    listTransits: async function (listOpts) {
      listOpts = listOpts || {};
      var sql = "SELECT * FROM carrier_transits WHERE archived_at IS NULL";
      var params = [];
      if (listOpts.carrier != null) {
        _carrier(listOpts.carrier);
        sql += " AND carrier = ?1";
        params.push(listOpts.carrier);
      }
      sql += " ORDER BY from_zone ASC, to_zone ASC, transit_days ASC, carrier ASC, service_level ASC";
      var r = await query(sql, params);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateTransit(r.rows[i]));
      return out;
    },

    listCutoffs: async function () {
      var r = await query(
        "SELECT * FROM shipping_cutoffs ORDER BY origin_location ASC",
        [],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateCutoff(r.rows[i]));
      return out;
    },

    listHolidays: async function (listOpts) {
      listOpts = listOpts || {};
      var where  = ["archived_at IS NULL"];
      var params = [];
      var idx    = 1;
      if (listOpts.region != null) {
        var region = _region(listOpts.region, "region");
        where.push("region = ?" + idx);
        params.push(region);
        idx += 1;
      }
      if (listOpts.from != null) {
        _date(listOpts.from, "from");
        where.push("date >= ?" + idx);
        params.push(listOpts.from);
        idx += 1;
      }
      if (listOpts.to != null) {
        _date(listOpts.to, "to");
        where.push("date <= ?" + idx);
        params.push(listOpts.to);
        idx += 1;
      }
      var sql = "SELECT * FROM shipping_holidays WHERE " + where.join(" AND ") +
                " ORDER BY date ASC, region ASC";
      var r = await query(sql, params);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateHoliday(r.rows[i]));
      return out;
    },

    listPostalZones: async function (listOpts) {
      listOpts = listOpts || {};
      var sql = "SELECT * FROM delivery_postal_zones";
      var params = [];
      if (listOpts.country != null) {
        var country = _country(listOpts.country, "country");
        sql += " WHERE country = ?1";
        params.push(country);
      }
      sql += " ORDER BY country ASC, postal_prefix ASC";
      var r = await query(sql, params);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) out.push(_hydratePostalZone(r.rows[i]));
      return out;
    },

    // Soft-delete a transit row by id. Idempotent — archiving an
    // already-archived row returns it unchanged. Archived rows drop
    // out of estimate() math but stay on disk for the audit trail.
    archiveTransit: async function (transitId) {
      try { b.guardUuid.sanitize(transitId, { profile: "strict" }); }
      catch (_e) { throw new TypeError("deliveryEstimate.archiveTransit: transit_id must be a valid uuid"); }
      var current = (await query(
        "SELECT * FROM carrier_transits WHERE id = ?1",
        [transitId],
      )).rows[0];
      if (!current) return null;
      if (current.archived_at != null) return _hydrateTransit(current);
      var ts = _now();
      await query(
        "UPDATE carrier_transits SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
        [ts, transitId],
      );
      var r = await query(
        "SELECT * FROM carrier_transits WHERE id = ?1",
        [transitId],
      );
      return _hydrateTransit(r.rows[0]);
    },

    // Same shape as archiveTransit — soft-delete a single holiday.
    archiveHoliday: async function (holidayId) {
      try { b.guardUuid.sanitize(holidayId, { profile: "strict" }); }
      catch (_e) { throw new TypeError("deliveryEstimate.archiveHoliday: holiday_id must be a valid uuid"); }
      var current = (await query(
        "SELECT * FROM shipping_holidays WHERE id = ?1",
        [holidayId],
      )).rows[0];
      if (!current) return null;
      if (current.archived_at != null) return _hydrateHoliday(current);
      var ts = _now();
      await query(
        "UPDATE shipping_holidays SET archived_at = ?1 WHERE id = ?2",
        [ts, holidayId],
      );
      var r = await query(
        "SELECT * FROM shipping_holidays WHERE id = ?1",
        [holidayId],
      );
      return _hydrateHoliday(r.rows[0]);
    },
  };

  // Helper: resolve the origin's region for holiday-skip math. Prefers
  // an injected inventoryLocations resolver (`regionFor(slug)`) and
  // falls back to null (no origin-side holidays applied). Keeping the
  // resolver injected leaves the holiday-region naming convention to
  // the operator — `us-ca` / `us` / `eu-de` are equally valid keys
  // depending on the operator's policy.
  async function _resolveOriginRegion(origin) {
    if (inventoryLocations && typeof inventoryLocations.regionFor === "function") {
      try {
        var r = await inventoryLocations.regionFor(origin);
        if (typeof r === "string" && r.length) return r;
      } catch (_e) {
        // drop-silent — by design: the holiday-region lookup is a hint,
        // a missing region just means no origin-side holiday skips.
        return null;
      }
    }
    return null;
  }
}

module.exports = {
  create:           create,
  CARRIERS:         CARRIERS,
  MAX_TRANSIT_DAYS: MAX_TRANSIT_DAYS,
  MAX_WEIGHT_GRAMS: MAX_WEIGHT_GRAMS,
  ZONE_RE:          ZONE_RE,
  DATE_RE:          DATE_RE,
  TIME_RE:          TIME_RE,
  COUNTRY_RE:       COUNTRY_RE,
};
