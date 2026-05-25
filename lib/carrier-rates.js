"use strict";
/**
 * @module shop.carrierRates
 * @title  Carrier rates — at-checkout shipping rate shopping
 *
 * @intro
 *   Operator registers N rate sources (UPS / FedEx / USPS / DHL / a
 *   flat-rate fallback). For a (cart + ship-to) tuple the primitive
 *   returns sorted-by-cost rates with delivery-window estimates.
 *
 *   The framework does NOT call carrier APIs directly. Each carrier
 *   has its own auth + endpoint shape; the operator's worker drains a
 *   rate request, calls the carrier, and posts each quote back via
 *   `recordRateQuote`. The primitive caches every quote until the
 *   carrier-declared `valid_until` expires, then `ratesForShipment`
 *   returns the live cached rates sorted ascending by cost. When no
 *   live carrier rate covers the request, the primitive composes a
 *   synthetic flat-rate fallback from the registered `flat_rate`
 *   carrier (if one exists) so the checkout never stalls.
 *
 *   Distinct from sibling primitives:
 *     - `shipping`          — per-order cost math at the till (the rate
 *                             the till charges; this primitive shops
 *                             the carrier menu that feeds it).
 *     - `shippingLabels`    — post-checkout broker-purchased label
 *                             artefact (tracking + PDF).
 *
 *   Composes:
 *     - `b.guardUuid`    — UUID-shape validation on every id input
 *     - `b.uuid.v7`      — quote row PK
 *     - `b.safeUrl.parse` — https-only `rate_endpoint` validation
 *     - `b.pagination`   — HMAC-tagged cursor for `recentQuotes`
 *
 *   Surface:
 *     registerCarrier({ slug, carrier, service_levels, rate_endpoint?, active })
 *     recordRateQuote({ carrier_slug, service_code, origin_postal,
 *                       dest_postal, weight_grams, dimensions,
 *                       rate_minor, currency, valid_until })
 *     ratesForShipment({ origin_postal, dest_postal, weight_grams,
 *                        dimensions })
 *     cleanupExpiredQuotes()
 *     recentQuotes({ carrier_slug?, from, to, limit, cursor? })
 *     metricsForCarrier({ slug, from, to })
 *
 *   Storage:
 *     - `carriers`             (migration `0080_carrier_rates.sql`)
 *     - `carrier_rate_quotes`  (migration `0080_carrier_rates.sql`)
 *
 * @primitive carrierRates
 * @related   b.guardUuid, b.uuid, b.safeUrl, b.pagination, shop.shipping
 */

var CARRIERS = Object.freeze(["ups", "fedex", "usps", "dhl", "flat_rate"]);

var MAX_SLUG_LEN          = 64;
var SLUG_RE               = /^[a-z0-9][a-z0-9_-]{0,63}$/;

var MAX_SERVICE_CODE_LEN  = 64;
var SERVICE_CODE_RE       = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

var MAX_SERVICE_LABEL_LEN = 128;
var MAX_SERVICE_LEVELS    = 32;

var MAX_POSTAL_LEN        = 16;
var POSTAL_RE             = /^[A-Za-z0-9][A-Za-z0-9 -]{0,15}$/;

var MAX_ENDPOINT_URL_LEN  = 2048;

var DEFAULT_RECENT_LIMIT  = 25;
var MAX_RECENT_LIMIT      = 200;

var MAX_DIMENSION_MM      = 5000;       // 5 m — generous, catches absurd input
var MAX_WEIGHT_GRAMS      = 1000 * 1000; // allow:raw-time-literal — grams, not a duration (1 t — generous, catches absurd input)

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
    throw new TypeError("carrierRates: slug must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("carrierRates: slug must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "carrierRates: slug must match /^[a-z0-9][a-z0-9_-]{0,63}$/ — " +
      "lowercase alphanumerics with `_`/`-`, must not start with separator"
    );
  }
  return s;
}

function _carrier(c) {
  if (typeof c !== "string" || CARRIERS.indexOf(c) === -1) {
    throw new TypeError("carrierRates: carrier must be one of " + CARRIERS.join(", "));
  }
  return c;
}

function _serviceCode(c, label) {
  if (typeof c !== "string" || !c.length) {
    throw new TypeError("carrierRates: " + label + " must be a non-empty string");
  }
  if (c.length > MAX_SERVICE_CODE_LEN) {
    throw new TypeError("carrierRates: " + label + " must be <= " + MAX_SERVICE_CODE_LEN + " characters");
  }
  if (!SERVICE_CODE_RE.test(c)) {
    throw new TypeError(
      "carrierRates: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/"
    );
  }
  return c;
}

function _serviceLevels(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TypeError("carrierRates: service_levels must be a non-empty array");
  }
  if (arr.length > MAX_SERVICE_LEVELS) {
    throw new TypeError("carrierRates: service_levels must be <= " + MAX_SERVICE_LEVELS + " entries");
  }
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var lvl = arr[i];
    if (!lvl || typeof lvl !== "object" || Array.isArray(lvl)) {
      throw new TypeError("carrierRates: service_levels[" + i + "] must be an object");
    }
    var code = _serviceCode(lvl.code, "service_levels[" + i + "].code");
    if (Object.prototype.hasOwnProperty.call(seen, code)) {
      throw new TypeError("carrierRates: service_levels[" + i + "].code duplicates an earlier entry");
    }
    seen[code] = true;
    if (typeof lvl.label !== "string" || !lvl.label.length) {
      throw new TypeError("carrierRates: service_levels[" + i + "].label must be a non-empty string");
    }
    if (lvl.label.length > MAX_SERVICE_LABEL_LEN) {
      throw new TypeError("carrierRates: service_levels[" + i + "].label must be <= " + MAX_SERVICE_LABEL_LEN + " characters");
    }
    if (_hasControlByte(lvl.label)) {
      throw new TypeError("carrierRates: service_levels[" + i + "].label must not contain control characters");
    }
    if (!Number.isInteger(lvl.sla_days) || lvl.sla_days < 0 || lvl.sla_days > 365) {
      throw new TypeError("carrierRates: service_levels[" + i + "].sla_days must be an integer 0..365");
    }
    out.push({ code: code, label: lvl.label, sla_days: lvl.sla_days });
  }
  return out;
}

function _rateEndpoint(url) {
  if (url == null || url === "") return null;
  if (typeof url !== "string") {
    throw new TypeError("carrierRates: rate_endpoint must be a string when provided");
  }
  if (url.length > MAX_ENDPOINT_URL_LEN) {
    throw new TypeError("carrierRates: rate_endpoint must be <= " + MAX_ENDPOINT_URL_LEN + " characters");
  }
  if (_hasControlByte(url)) {
    throw new TypeError("carrierRates: rate_endpoint must not contain control characters");
  }
  // safeUrl.parse defaults to ALLOW_HTTP_TLS (https only). The framework
  // refuses http:// + non-http schemes + user:pass@ userinfo + bracketed
  // raw-IP forms at this gate — operators forwarding rate requests over
  // cleartext would leak the shopping pattern; refuse at the door.
  try {
    _b().safeUrl.parse(url, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("carrierRates: rate_endpoint — " + (e && e.message || "must be a valid https:// URL"));
  }
  return url;
}

function _active(a) {
  if (typeof a !== "boolean") {
    throw new TypeError("carrierRates: active must be a boolean");
  }
  return a ? 1 : 0;
}

function _postal(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("carrierRates: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_POSTAL_LEN) {
    throw new TypeError("carrierRates: " + label + " must be <= " + MAX_POSTAL_LEN + " characters");
  }
  if (!POSTAL_RE.test(s)) {
    throw new TypeError(
      "carrierRates: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9 -]{0,15}$/ " +
      "(alphanumerics with embedded space or `-`)"
    );
  }
  return s;
}

function _weightGrams(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_WEIGHT_GRAMS) {
    throw new TypeError(
      "carrierRates: weight_grams must be a positive integer <= " + MAX_WEIGHT_GRAMS
    );
  }
  return n;
}

function _dimensions(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    throw new TypeError("carrierRates: dimensions must be an object {length_mm, width_mm, height_mm}");
  }
  var keys = ["length_mm", "width_mm", "height_mm"];
  for (var i = 0; i < keys.length; i += 1) {
    var k = keys[i];
    var v = d[k];
    if (!Number.isInteger(v) || v <= 0 || v > MAX_DIMENSION_MM) {
      throw new TypeError(
        "carrierRates: dimensions." + k + " must be a positive integer <= " + MAX_DIMENSION_MM
      );
    }
  }
  return {
    length_mm: d.length_mm,
    width_mm:  d.width_mm,
    height_mm: d.height_mm,
  };
}

function _rateMinor(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("carrierRates: rate_minor must be a non-negative integer");
  }
  return n;
}

function _currency(c) {
  if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("carrierRates: currency must be 3-letter uppercase ISO 4217");
  }
  return c;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("carrierRates: " + label + " must be a positive integer epoch-ms");
  }
  return n;
}

function _limit(n) {
  if (n == null) return DEFAULT_RECENT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_RECENT_LIMIT) {
    throw new TypeError("carrierRates: limit must be an integer 1..." + MAX_RECENT_LIMIT);
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
  var cursorSecret = opts.cursorSecret || null;
  if (cursorSecret != null && (typeof cursorSecret !== "string" || !cursorSecret.length)) {
    throw new TypeError("carrierRates.create: opts.cursorSecret must be a non-empty string when provided");
  }

  function _hydrateCarrier(row) {
    if (!row) return null;
    var levels = [];
    try { levels = JSON.parse(row.service_levels_json || "[]"); }
    catch (_e) { levels = []; }
    return {
      slug:           row.slug,
      carrier:        row.carrier,
      service_levels: levels,
      rate_endpoint:  row.rate_endpoint == null ? null : row.rate_endpoint,
      active:         Number(row.active) === 1,
      created_at:     Number(row.created_at),
      updated_at:     Number(row.updated_at),
    };
  }

  function _hydrateQuote(row) {
    if (!row) return null;
    var dims = { length_mm: 0, width_mm: 0, height_mm: 0 };
    try { dims = JSON.parse(row.dimensions_json || "{}"); }
    catch (_e) { /* drop-silent — by design; row content is operator-supplied JSON */ }
    return {
      id:            row.id,
      carrier_slug:  row.carrier_slug,
      service_code:  row.service_code,
      origin_postal: row.origin_postal,
      dest_postal:   row.dest_postal,
      weight_grams:  Number(row.weight_grams),
      dimensions:    dims,
      rate_minor:    Number(row.rate_minor),
      currency:      row.currency,
      valid_until:   Number(row.valid_until),
      queried_at:    Number(row.queried_at),
    };
  }

  async function _getCarrierRow(slug) {
    var r = await query("SELECT * FROM carriers WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  return {
    CARRIERS:             CARRIERS,
    MAX_SERVICE_LEVELS:   MAX_SERVICE_LEVELS,
    MAX_RECENT_LIMIT:     MAX_RECENT_LIMIT,

    // Register (or update) an operator's rate source. Upsert on slug
    // — repeating with the same slug replaces the carrier shape +
    // service-level menu in place so an operator paused-then-rotated
    // an account doesn't accumulate stale rows.
    registerCarrier: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrierRates.registerCarrier: input object required");
      }
      var slug          = _slug(input.slug);
      var carrier       = _carrier(input.carrier);
      var serviceLevels = _serviceLevels(input.service_levels);
      var rateEndpoint  = _rateEndpoint(input.rate_endpoint);
      var active        = _active(input.active);

      var ts = _now();
      var existing = await _getCarrierRow(slug);
      var createdAt = existing ? Number(existing.created_at) : ts;

      await query(
        "INSERT INTO carriers " +
        "(slug, carrier, service_levels_json, rate_endpoint, active, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
        "ON CONFLICT(slug) DO UPDATE SET " +
        "  carrier             = excluded.carrier, " +
        "  service_levels_json = excluded.service_levels_json, " +
        "  rate_endpoint       = excluded.rate_endpoint, " +
        "  active              = excluded.active, " +
        "  updated_at          = excluded.updated_at",
        [
          slug, carrier, JSON.stringify(serviceLevels), rateEndpoint,
          active, createdAt, ts,
        ],
      );
      return _hydrateCarrier(await _getCarrierRow(slug));
    },

    // Cache one carrier-minted quote. The UNIQUE
    // (carrier_slug, service_code, origin_postal, dest_postal,
    // weight_grams) key dedups — a fresh quote with the same shape
    // refreshes rate + valid_until in place, never stacks.
    recordRateQuote: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrierRates.recordRateQuote: input object required");
      }
      var slug         = _slug(input.carrier_slug);
      var serviceCode  = _serviceCode(input.service_code, "service_code");
      var originPostal = _postal(input.origin_postal, "origin_postal");
      var destPostal   = _postal(input.dest_postal, "dest_postal");
      var weightGrams  = _weightGrams(input.weight_grams);
      var dimensions   = _dimensions(input.dimensions);
      var rateMinor    = _rateMinor(input.rate_minor);
      var currency     = _currency(input.currency);
      var validUntil   = _epochMs(input.valid_until, "valid_until");

      var carrierRow = await _getCarrierRow(slug);
      if (!carrierRow) {
        throw new TypeError("carrierRates.recordRateQuote: carrier '" + slug + "' not registered");
      }
      // Service code must appear in the carrier's registered menu.
      // Operators rotating service-level offerings re-call
      // `registerCarrier` first; a quote for an unmenued code is the
      // worker drifting against the operator's intent — refuse loud.
      var menu;
      try { menu = JSON.parse(carrierRow.service_levels_json || "[]"); }
      catch (_e) { menu = []; }
      var menued = false;
      for (var i = 0; i < menu.length; i += 1) {
        if (menu[i] && menu[i].code === serviceCode) { menued = true; break; }
      }
      if (!menued) {
        throw new TypeError(
          "carrierRates.recordRateQuote: service_code '" + serviceCode +
          "' not in carrier '" + slug + "' service_levels menu"
        );
      }

      var ts = _now();
      // Pre-resolve the existing row id (if any) so the upsert keeps a
      // stable id across refreshes — the audit trail in `recentQuotes`
      // stays threaded by id rather than churning a new uuid per
      // refresh. INSERT OR REPLACE without the lookup would re-mint.
      var existing = (await query(
        "SELECT id FROM carrier_rate_quotes " +
        "WHERE carrier_slug = ?1 AND service_code = ?2 " +
        "  AND origin_postal = ?3 AND dest_postal = ?4 AND weight_grams = ?5",
        [slug, serviceCode, originPostal, destPostal, weightGrams],
      )).rows[0];
      var id = existing ? existing.id : _b().uuid.v7();

      await query(
        "INSERT INTO carrier_rate_quotes " +
        "(id, carrier_slug, service_code, origin_postal, dest_postal, " +
        " weight_grams, dimensions_json, rate_minor, currency, " +
        " valid_until, queried_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) " +
        "ON CONFLICT(carrier_slug, service_code, origin_postal, dest_postal, weight_grams) " +
        "DO UPDATE SET " +
        "  dimensions_json = excluded.dimensions_json, " +
        "  rate_minor      = excluded.rate_minor, " +
        "  currency        = excluded.currency, " +
        "  valid_until     = excluded.valid_until, " +
        "  queried_at      = excluded.queried_at",
        [
          id, slug, serviceCode, originPostal, destPostal,
          weightGrams, JSON.stringify(dimensions), rateMinor, currency,
          validUntil, ts,
        ],
      );

      var r = await query("SELECT * FROM carrier_rate_quotes WHERE id = ?1", [id]);
      return _hydrateQuote(r.rows[0]);
    },

    // Read live cached rates for a shipment. ORDER BY rate_minor ASC
    // so the cheapest live option surfaces first; the operator
    // checkout typically renders the top N. The `dimensions` input is
    // operator-reported for transparency but not part of the lookup
    // key (operators packing a 30cm + 60cm box for the same address
    // typically run two recordRateQuote calls with different weights;
    // dimensions are stored on each quote so the checkout can pick
    // the right one out of band when needed).
    //
    // When no live carrier rate exists, the primitive composes a
    // synthetic fallback row per registered `flat_rate` carrier so
    // the checkout never stalls on an empty rate pool. The synthetic
    // row uses each flat_rate carrier's first service level + a
    // documented FLAT_RATE_FALLBACK rate_minor of 0 (the operator
    // overrides via a stored quote when they care about a non-zero
    // baseline). Synthetic rows carry `synthetic: true` so the
    // checkout can label them distinctly.
    ratesForShipment: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrierRates.ratesForShipment: input object required");
      }
      var originPostal = _postal(input.origin_postal, "origin_postal");
      var destPostal   = _postal(input.dest_postal, "dest_postal");
      var weightGrams  = _weightGrams(input.weight_grams);
      _dimensions(input.dimensions);

      var now = _now();
      // Join in carrier_slug -> carriers.active so a paused carrier
      // drops out of the rate pool without operator scrubbing the
      // cached quotes (resuming the carrier surfaces the cache again).
      var rows = (await query(
        "SELECT q.*, c.active AS carrier_active, c.service_levels_json AS carrier_levels_json " +
        "FROM carrier_rate_quotes q " +
        "JOIN carriers c ON c.slug = q.carrier_slug " +
        "WHERE q.origin_postal = ?1 AND q.dest_postal = ?2 " +
        "  AND q.weight_grams = ?3 AND q.valid_until > ?4 " +
        "  AND c.active = 1 " +
        "ORDER BY q.rate_minor ASC, q.queried_at DESC, q.id ASC",
        [originPostal, destPostal, weightGrams, now],
      )).rows;

      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var hydrated = _hydrateQuote(rows[i]);
        // Decorate with the matching service_level entry so the
        // checkout can render label + sla_days without a second
        // lookup.
        var levels = [];
        try { levels = JSON.parse(rows[i].carrier_levels_json || "[]"); }
        catch (_e) { levels = []; }
        var serviceLevel = null;
        for (var j = 0; j < levels.length; j += 1) {
          if (levels[j] && levels[j].code === hydrated.service_code) {
            serviceLevel = levels[j];
            break;
          }
        }
        hydrated.service_label = serviceLevel ? serviceLevel.label : null;
        hydrated.sla_days      = serviceLevel ? serviceLevel.sla_days : null;
        hydrated.synthetic     = false;
        out.push(hydrated);
      }

      if (out.length > 0) return out;

      // Empty pool — compose synthetic flat-rate fallbacks. The
      // operator registers a `flat_rate` carrier with at least one
      // service level; the synthetic row borrows that menu so the
      // checkout sees a consistent shape (label + sla_days + service
      // code). The synthetic rate_minor is 0 — operators wanting a
      // non-zero baseline post a real recordRateQuote against the
      // flat_rate slug with the desired rate.
      var flatRows = (await query(
        "SELECT * FROM carriers WHERE carrier = 'flat_rate' AND active = 1 " +
        "ORDER BY slug ASC",
        [],
      )).rows;
      for (var k = 0; k < flatRows.length; k += 1) {
        var flat = _hydrateCarrier(flatRows[k]);
        if (!flat.service_levels.length) continue;
        var first = flat.service_levels[0];
        out.push({
          id:            null,
          carrier_slug:  flat.slug,
          service_code:  first.code,
          service_label: first.label,
          sla_days:      first.sla_days,
          origin_postal: originPostal,
          dest_postal:   destPostal,
          weight_grams:  weightGrams,
          dimensions:    _dimensions(input.dimensions),
          rate_minor:    0,
          currency:      null,
          valid_until:   null,
          queried_at:    null,
          synthetic:     true,
        });
      }
      return out;
    },

    // Prune every row whose carrier-declared `valid_until` has
    // already passed. Operator-side housekeeping — the rate-lookup
    // path filters expired rows out at read time, so this is a disk-
    // reclaim hint, not a correctness gate. Returns the count pruned.
    cleanupExpiredQuotes: async function () {
      var now = _now();
      var r = await query(
        "DELETE FROM carrier_rate_quotes WHERE valid_until <= ?1",
        [now],
      );
      return { pruned: Number(r.rowCount || 0) };
    },

    // Operator dashboard feed — paginated by (queried_at DESC, id
    // DESC). Cursor is HMAC-tagged via b.pagination so an operator
    // can't hand-craft one to skip past a hidden row. Filters by
    // `carrier_slug` when supplied + the [from, to] queried_at
    // window (inclusive on both ends).
    recentQuotes: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("carrierRates.recentQuotes: opts object required");
      }
      var from  = _epochMs(listOpts.from, "from");
      var to    = _epochMs(listOpts.to,   "to");
      if (to < from) {
        throw new TypeError("carrierRates.recentQuotes: to must be >= from");
      }
      var limit = _limit(listOpts.limit);
      var carrierFilter = null;
      if (listOpts.carrier_slug != null) {
        carrierFilter = _slug(listOpts.carrier_slug);
      }
      var orderKey = ["queried_at:desc", "id:desc"];
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("carrierRates.recentQuotes: cursor must be an opaque string or null");
        }
        try {
          var state = _b().pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(orderKey)) {
            throw new TypeError("carrierRates.recentQuotes: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("carrierRates.recentQuotes: cursor — " + (e && e.message || "malformed"));
        }
      }

      var where  = ["queried_at >= ?1", "queried_at <= ?2"];
      var params = [from, to];
      var idx    = 3;
      if (carrierFilter) {
        where.push("carrier_slug = ?" + idx);
        params.push(carrierFilter);
        idx += 1;
      }
      if (cursorVals) {
        where.push("(queried_at < ?" + idx + " OR (queried_at = ?" + idx + " AND id < ?" + (idx + 1) + "))");
        params.push(cursorVals[0]);
        params.push(cursorVals[1]);
        idx += 2;
      }
      var sql =
        "SELECT * FROM carrier_rate_quotes WHERE " + where.join(" AND ") +
        " ORDER BY queried_at DESC, id DESC LIMIT ?" + idx;
      params.push(limit);

      var rows = (await query(sql, params)).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) out.push(_hydrateQuote(rows[i]));
      var last = out[out.length - 1];
      var next = null;
      if (last && out.length === limit) {
        next = _b().pagination.encodeCursor({
          orderKey: orderKey,
          vals:     [last.queried_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: out, next_cursor: next };
    },

    // Per-carrier aggregate over a queried_at window. Counts the
    // quotes recorded + reports min/max/avg rate_minor per currency
    // (mixing USD + EUR into a single avg is silently lossy, so the
    // group key includes currency). Operators use the report to spot
    // a carrier whose rates drifted up week-over-week or a
    // service code that's silently degenerating.
    metricsForCarrier: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("carrierRates.metricsForCarrier: input object required");
      }
      var slug = _slug(input.slug);
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (to < from) {
        throw new TypeError("carrierRates.metricsForCarrier: to must be >= from");
      }
      var rows = (await query(
        "SELECT service_code, currency, " +
        "       COUNT(*) AS quote_count, " +
        "       MIN(rate_minor) AS min_minor, " +
        "       MAX(rate_minor) AS max_minor, " +
        "       AVG(rate_minor) AS avg_minor " +
        "FROM carrier_rate_quotes " +
        "WHERE carrier_slug = ?1 AND queried_at >= ?2 AND queried_at <= ?3 " +
        "GROUP BY service_code, currency " +
        "ORDER BY service_code ASC, currency ASC",
        [slug, from, to],
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var r = rows[i];
        out.push({
          carrier_slug: slug,
          service_code: r.service_code,
          currency:     r.currency,
          quote_count:  Number(r.quote_count),
          min_minor:    Number(r.min_minor),
          max_minor:    Number(r.max_minor),
          avg_minor:    Number(r.avg_minor),
        });
      }
      return out;
    },
  };
}

module.exports = {
  create:             create,
  CARRIERS:           CARRIERS,
  MAX_SERVICE_LEVELS: MAX_SERVICE_LEVELS,
  MAX_RECENT_LIMIT:   MAX_RECENT_LIMIT,
};
