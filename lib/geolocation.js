"use strict";
/**
 * @module shop.geolocation
 * @title  Geolocation primitive — country/region resolution from
 *         request hints + operator-managed per-country defaults
 *
 * @intro
 *   The shop never performs an in-process IP-to-country lookup. The
 *   operator hands the primitive a bundle of pre-resolved hints
 *   (typically Cloudflare's `CF-IPCountry` + `cf-region` edge headers,
 *   the browser's `Accept-Language` and `Intl.DateTimeFormat()
 *   .resolvedOptions().timeZone`, and an optional buyer-supplied
 *   country from a country picker) and the primitive merges them with
 *   the per-country settings stored in `country_settings`. The merged
 *   result drives currency display, locale-aware formatting, the
 *   checkout's payment-method + shipping-method menus, and the
 *   sanctions / no-coverage geo-block gate.
 *
 *   Resolution precedence (highest -> lowest):
 *
 *     1. `customer_supplied_country` — wins ONLY when a row exists for
 *        the supplied code. Buyers who explicitly pick a country in a
 *        UI override the edge-resolved guess (a traveler on a US IP
 *        shipping to their home address in DE expects DE pricing).
 *        An undefined supplied country falls through to the next hint
 *        rather than throwing, so a stale dropdown value doesn't break
 *        checkout.
 *     2. `cf_country` — the Cloudflare edge's IP-to-country answer.
 *        Required.
 *
 *   Region: from `cf_region` when supplied. Returned only when both
 *   the country resolves and a region was hinted; never invented.
 *
 *   Locale: by default the row's `default_locale`. When `accept_language`
 *   is supplied the resolver walks the q-sorted tag list and returns
 *   the first tag whose primary subtag matches the row default's
 *   primary subtag (e.g. an "en-US" default upgrades to "en-GB" when
 *   the browser prefers `en-GB,en;q=0.9`); when no tag matches the
 *   primary subtag the row default wins.
 *
 *   Timezone: passthrough when the request hint is supplied (validated
 *   as IANA shape but not against a tzdata catalog — the framework
 *   does not vendor IANA data and the operator's downstream renderers
 *   tolerate unknown ids). When the hint is absent, the row's
 *   `default_timezone` is returned, which may itself be null for
 *   countries that straddle zones (US, RU, AU, BR, CA).
 *
 *   Composition:
 *     var geo = bShop.geolocation.create({ query: q });
 *     await geo.defineCountry({
 *       code:                   "DE",
 *       currency:               "EUR",
 *       default_locale:         "de-DE",
 *       geo_blocked:            false,
 *       allowed_payment_kinds:  ["card", "sepa_debit", "klarna"],
 *       allowed_shipping_kinds: ["standard", "express"],
 *       default_timezone:       "Europe/Berlin",
 *     });
 *     var resolved = await geo.resolve({
 *       cf_country:      "DE",
 *       cf_region:       "BE",
 *       accept_language: "de-DE,de;q=0.9,en;q=0.5",
 *       timezone:        "Europe/Berlin",
 *     });
 *     // -> { country: "DE", region: "BE", currency: "EUR",
 *     //      locale: "de-DE", timezone: "Europe/Berlin",
 *     //      geo_blocked: false,
 *     //      allowed_payment_kinds:  ["card", "sepa_debit", "klarna"],
 *     //      allowed_shipping_kinds: ["standard", "express"] }
 *
 *   Storage:
 *     - `country_settings` (migration `0092_geolocation.sql`).
 *
 * @primitive geolocation
 */

var b = require("./vendor/blamejs");

// ISO 3166-1 alpha-2 — exactly two uppercase letters. The schema
// CHECK enforces the same shape; the regex is the strict gate at the
// app tier so a typo throws at the call site rather than producing a
// SQLITE_CONSTRAINT error one stack frame deeper.
var COUNTRY_CODE_RE = /^[A-Z]{2}$/;

// ISO 4217 — three uppercase letters. Same posture as country code.
var CURRENCY_RE = /^[A-Z]{3}$/;

// BCP-47 locale — primary language subtag (2-3 letters) optionally
// followed by region / script / variant subtags joined by `-`. We
// don't try to round-trip the full RFC 5646 grammar — practical
// storefront locales fit the `lang(-Region)?` envelope, with the
// schema CHECK bounding total length at 35 characters (the IETF
// language-tag practical max).
var LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

// Region: ISO 3166-2 subdivision code without the country prefix —
// what Cloudflare's `cf-region` header returns (e.g. "CA" for
// California, "BE" for Berlin, "ENG" for England). 1-3 uppercase
// alphanumerics covers the practical world.
var REGION_RE = /^[A-Z0-9]{1,3}$/;

// IANA timezone id — `Area/Location` (with optional sub-location for
// Indianapolis-style entries). Validated for shape only — we don't
// vendor tzdata; the operator's downstream renderers tolerate
// unknown ids.
var TIMEZONE_RE = /^[A-Z][A-Za-z_+\-]{0,32}(?:\/[A-Za-z0-9_+\-]{1,32}){1,2}$/;

// Kind strings (operator-defined payment + shipping menu vocabulary).
// Lowercase alphanumeric + underscore + dash, 1-32 chars. Bounded so
// "<script>" / control bytes / huge payloads can't slip in via a UI
// that wasn't validating its checkout config.
var KIND_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
var KIND_MAX_COUNT = 32;

var REASON_MAX_LEN = 512;

// Patch-update vocabulary. `code` is the primary key — to "rename" a
// country, define the new code and delete (or block) the old one.
var ALLOWED_UPDATE_COLUMNS = Object.freeze([
  "currency",
  "default_locale",
  "allowed_payment_kinds",
  "allowed_shipping_kinds",
  "default_timezone",
  // geo_blocked + geo_block_reason flow through setGeoBlock so the
  // two columns can never drift out of sync (blocked=1 without a
  // reason / blocked=0 with a stale reason).
]);

// ---- validators ---------------------------------------------------------

function _countryCode(s, label) {
  label = label || "code";
  if (typeof s !== "string" || !COUNTRY_CODE_RE.test(s)) {
    throw new TypeError(
      "geolocation: " + label + " must be an ISO 3166-1 alpha-2 country code " +
      "(two uppercase letters), got " + JSON.stringify(s)
    );
  }
  return s;
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError(
      "geolocation: currency must be an ISO 4217 three-letter code " +
      "(uppercase), got " + JSON.stringify(s)
    );
  }
  return s;
}

function _locale(s, label) {
  label = label || "default_locale";
  if (typeof s !== "string" || !LOCALE_RE.test(s) || s.length > 35) {
    throw new TypeError(
      "geolocation: " + label + " must be a BCP-47 language tag " +
      "(e.g. 'en-US', 'de-DE'), got " + JSON.stringify(s)
    );
  }
  return s;
}

function _region(s) {
  if (typeof s !== "string" || !REGION_RE.test(s)) {
    throw new TypeError(
      "geolocation: region must be 1-3 uppercase alphanumerics " +
      "(ISO 3166-2 subdivision without country prefix), got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _timezone(s, label) {
  label = label || "timezone";
  if (typeof s !== "string" || !TIMEZONE_RE.test(s)) {
    throw new TypeError(
      "geolocation: " + label + " must be an IANA timezone id " +
      "(e.g. 'Europe/Berlin', 'America/Los_Angeles'), got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _kindList(arr, label) {
  if (!Array.isArray(arr)) {
    throw new TypeError("geolocation: " + label + " must be an array of strings");
  }
  if (arr.length > KIND_MAX_COUNT) {
    throw new TypeError(
      "geolocation: " + label + " must contain at most " + KIND_MAX_COUNT +
      " entries, got " + arr.length
    );
  }
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var k = arr[i];
    if (typeof k !== "string" || !KIND_RE.test(k)) {
      throw new TypeError(
        "geolocation: " + label + "[" + i + "] must match " +
        "/^[a-z0-9][a-z0-9_-]{0,31}$/, got " + JSON.stringify(k)
      );
    }
    if (seen[k]) {
      throw new TypeError(
        "geolocation: " + label + " must not contain duplicates, got " +
        JSON.stringify(k) + " twice"
      );
    }
    seen[k] = true;
    out.push(k);
  }
  return out;
}

function _reason(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("geolocation: reason must be a string or null");
  }
  if (!s.length) return null;
  if (s.length > REASON_MAX_LEN) {
    throw new TypeError(
      "geolocation: reason must be <= " + REASON_MAX_LEN + " characters"
    );
  }
  // Refuse control bytes — operator-display field, gets rendered
  // verbatim in dashboards + audit log lines; embedded newlines are
  // a log-injection vector.
  if (/[\x00-\x1F\x7F]/.test(s)) {
    throw new TypeError("geolocation: reason must not contain control bytes");
  }
  return s;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("geolocation: " + label + " must be a boolean");
  }
  return v;
}

function _now() { return Date.now(); }

// ---- accept-language parsing -------------------------------------------

// Parse an RFC 7231 `Accept-Language` header into a list of
// `{ tag, q }` entries sorted by q descending (stable on ties — first
// occurrence wins). Garbage entries are silently dropped; the worst
// case is a header whose every entry is malformed, which falls
// through to the country's default_locale.
function _parseAcceptLanguage(raw) {
  if (typeof raw !== "string" || !raw.length) return [];
  var entries = raw.split(",");
  var parsed = [];
  for (var i = 0; i < entries.length; i += 1) {
    var part = entries[i].trim();
    if (!part) continue;
    var semi = part.indexOf(";");
    var tag = (semi === -1 ? part : part.slice(0, semi)).trim();
    var q = 1.0;
    if (semi !== -1) {
      var attrs = part.slice(semi + 1).split(";");
      for (var j = 0; j < attrs.length; j += 1) {
        var a = attrs[j].trim();
        if (a.slice(0, 2).toLowerCase() === "q=") {
          var n = parseFloat(a.slice(2));
          if (isFinite(n) && n >= 0 && n <= 1) q = n;
        }
      }
    }
    if (tag === "*") continue;
    if (!LOCALE_RE.test(tag)) continue;
    parsed.push({ tag: tag, q: q, order: i });
  }
  // Stable q-desc sort (preserve original order on ties).
  parsed.sort(function (a, b) {
    if (a.q !== b.q) return b.q - a.q;
    return a.order - b.order;
  });
  return parsed;
}

function _primarySubtag(tag) {
  var dash = tag.indexOf("-");
  return (dash === -1 ? tag : tag.slice(0, dash)).toLowerCase();
}

// Choose the locale the storefront should render in. The row's
// `default_locale` is the baseline; if the request's accept-language
// list contains a tag whose primary subtag matches the row default's
// primary subtag, that tag wins (preserving region preferences — a
// `de-DE` default upgrades to `de-AT` when the browser asks for it).
// When no tag matches, the row default wins.
function _pickLocale(rowDefault, acceptLanguage) {
  if (!acceptLanguage) return rowDefault;
  var entries = _parseAcceptLanguage(acceptLanguage);
  if (!entries.length) return rowDefault;
  var defaultPrimary = _primarySubtag(rowDefault);
  for (var i = 0; i < entries.length; i += 1) {
    if (_primarySubtag(entries[i].tag) === defaultPrimary) {
      return entries[i].tag;
    }
  }
  return rowDefault;
}

// ---- row <-> wire conversions ------------------------------------------

function _parseKindsJson(raw, label) {
  if (raw == null) return [];
  if (typeof raw !== "string") return [];
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch (_e) {
    // A row whose JSON column is malformed is a storage-corruption
    // signal — surface it as a clear app-tier error rather than a
    // silent empty list (which would let a broken row look like an
    // intentionally empty menu).
    throw new Error(
      "geolocation: " + label + " column is malformed JSON — storage corruption"
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "geolocation: " + label + " column must be a JSON array — storage corruption"
    );
  }
  return parsed;
}

function _rowToCountry(row) {
  if (!row) return null;
  return {
    code:                   row.code,
    currency:               row.currency,
    default_locale:         row.default_locale,
    geo_blocked:            Number(row.geo_blocked) === 1,
    geo_block_reason:       row.geo_block_reason == null ? null : row.geo_block_reason,
    allowed_payment_kinds:  _parseKindsJson(row.allowed_payment_kinds_json,  "allowed_payment_kinds_json"),
    allowed_shipping_kinds: _parseKindsJson(row.allowed_shipping_kinds_json, "allowed_shipping_kinds_json"),
    default_timezone:       row.default_timezone == null ? null : row.default_timezone,
    created_at:             Number(row.created_at),
    updated_at:             Number(row.updated_at),
  };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  async function _getRow(code) {
    var r = await query(
      "SELECT * FROM country_settings WHERE code = ?1",
      [code],
    );
    return r.rows[0] || null;
  }

  return {
    COUNTRY_CODE_RE: COUNTRY_CODE_RE,
    CURRENCY_RE:     CURRENCY_RE,
    LOCALE_RE:       LOCALE_RE,
    REGION_RE:       REGION_RE,
    KIND_MAX_COUNT:  KIND_MAX_COUNT,

    // Write one country's settings. Refuses if a row already exists
    // for the code — operators mutating an existing country go
    // through `updateCountry` so the patch surface is the single
    // mutation entry point (and `code` stays immutable). Set
    // geo_block via the dedicated `setGeoBlock` call to keep
    // blocked + reason in sync.
    defineCountry: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("geolocation.defineCountry: input object required");
      }
      var code           = _countryCode(input.code, "code");
      var currency       = _currency(input.currency);
      var defaultLocale  = _locale(input.default_locale);
      var geoBlocked     = _bool(input.geo_blocked, "geo_blocked");
      var paymentKinds   = _kindList(input.allowed_payment_kinds,  "allowed_payment_kinds");
      var shippingKinds  = _kindList(input.allowed_shipping_kinds, "allowed_shipping_kinds");
      var defaultTz      = input.default_timezone == null ? null
                         : _timezone(input.default_timezone, "default_timezone");
      var reason         = input.geo_block_reason == null ? null : _reason(input.geo_block_reason);

      // geo_block_reason without geo_blocked=true is a misconfig —
      // operators write the reason at the same moment they flip the
      // block. Cleared the other way (blocked without a reason) is
      // allowed: some operators block-by-default without a published
      // rationale and surface a UI placeholder.
      if (reason != null && !geoBlocked) {
        throw new TypeError(
          "geolocation.defineCountry: geo_block_reason requires geo_blocked = true"
        );
      }

      var existing = await _getRow(code);
      if (existing) {
        var dupe = new Error(
          "geolocation.defineCountry: row already exists for " + code +
          " — use updateCountry / setGeoBlock to mutate"
        );
        dupe.code = "GEO_COUNTRY_EXISTS";
        throw dupe;
      }

      var ts = _now();
      await query(
        "INSERT INTO country_settings " +
        "(code, currency, default_locale, geo_blocked, geo_block_reason, " +
        " allowed_payment_kinds_json, allowed_shipping_kinds_json, " +
        " default_timezone, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        [
          code, currency, defaultLocale, geoBlocked ? 1 : 0, reason,
          JSON.stringify(paymentKinds), JSON.stringify(shippingKinds),
          defaultTz, ts,
        ],
      );
      return _rowToCountry(await _getRow(code));
    },

    getCountry: async function (code) {
      var c = _countryCode(code, "code");
      return _rowToCountry(await _getRow(c));
    },

    // List every defined country, optionally filtered by block state.
    listCountries: async function (input) {
      input = input || {};
      var sql, params;
      if (Object.prototype.hasOwnProperty.call(input, "geo_blocked")) {
        var flag = _bool(input.geo_blocked, "geo_blocked");
        sql = "SELECT * FROM country_settings WHERE geo_blocked = ?1 " +
              "ORDER BY code ASC";
        params = [flag ? 1 : 0];
      } else {
        sql = "SELECT * FROM country_settings ORDER BY code ASC";
        params = [];
      }
      var r = await query(sql, params);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        out.push(_rowToCountry(r.rows[i]));
      }
      return out;
    },

    // Patch-style update for the columns operators routinely tune.
    // `code` is the primary key (immutable post-creation); `geo_blocked`
    // + `geo_block_reason` flow through setGeoBlock so the two
    // columns can never drift out of sync.
    updateCountry: async function (code, patch) {
      var c = _countryCode(code, "code");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("geolocation.updateCountry: patch object required");
      }
      var keys = Object.keys(patch);
      if (!keys.length) {
        throw new TypeError("geolocation.updateCountry: patch must contain at least one column");
      }
      for (var i = 0; i < keys.length; i += 1) {
        if (ALLOWED_UPDATE_COLUMNS.indexOf(keys[i]) === -1) {
          throw new TypeError(
            "geolocation.updateCountry: column '" + keys[i] + "' not updatable " +
            "(use setGeoBlock for the geo_blocked / geo_block_reason pair)"
          );
        }
      }
      var current = await _getRow(c);
      if (!current) return null;

      var sets   = [];
      var params = [];
      var idx    = 1;
      function _set(col, val) {
        sets.push(col + " = ?" + idx);
        params.push(val);
        idx += 1;
      }
      if (patch.currency != null)        _set("currency",       _currency(patch.currency));
      if (patch.default_locale != null)  _set("default_locale", _locale(patch.default_locale));
      if (patch.allowed_payment_kinds != null) {
        _set("allowed_payment_kinds_json",
          JSON.stringify(_kindList(patch.allowed_payment_kinds, "allowed_payment_kinds")));
      }
      if (patch.allowed_shipping_kinds != null) {
        _set("allowed_shipping_kinds_json",
          JSON.stringify(_kindList(patch.allowed_shipping_kinds, "allowed_shipping_kinds")));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "default_timezone")) {
        var tz = patch.default_timezone == null
          ? null
          : _timezone(patch.default_timezone, "default_timezone");
        _set("default_timezone", tz);
      }

      var ts = _now();
      _set("updated_at", ts);
      params.push(c);
      var sql = "UPDATE country_settings SET " + sets.join(", ") +
                " WHERE code = ?" + idx;
      await query(sql, params);
      return _rowToCountry(await _getRow(c));
    },

    // Flip the geo-block state for one country. blocked=true requires
    // / accepts an operator-facing `reason`; blocked=false clears
    // any prior reason so the dashboard doesn't show stale text
    // alongside an unblocked country.
    setGeoBlock: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("geolocation.setGeoBlock: input object required");
      }
      var code    = _countryCode(input.country_code, "country_code");
      var blocked = _bool(input.blocked, "blocked");
      var reason  = input.reason == null ? null : _reason(input.reason);

      if (!blocked && reason != null) {
        throw new TypeError(
          "geolocation.setGeoBlock: reason is meaningless when blocked=false"
        );
      }

      var current = await _getRow(code);
      if (!current) return null;

      var ts = _now();
      // blocked=false clears any prior reason so the row never carries
      // a justification for a block it doesn't have.
      var nextReason = blocked ? reason : null;
      await query(
        "UPDATE country_settings " +
        "SET geo_blocked = ?1, geo_block_reason = ?2, updated_at = ?3 " +
        "WHERE code = ?4",
        [blocked ? 1 : 0, nextReason, ts, code],
      );
      return _rowToCountry(await _getRow(code));
    },

    // Convenience read — every country currently sitting on the
    // block list. Sorted by code so the dashboard renders
    // deterministically.
    blockedRoster: async function () {
      var r = await query(
        "SELECT * FROM country_settings WHERE geo_blocked = 1 ORDER BY code ASC",
        [],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        out.push(_rowToCountry(r.rows[i]));
      }
      return out;
    },

    // Resolve a request's hints into a country / region / currency /
    // locale / timezone / kinds tuple. The buyer-supplied override
    // wins ONLY when the supplied country has a row; a stale dropdown
    // value falls through to the edge hint rather than throwing.
    //
    // Returns null when the resolved country has no row — checkout
    // refuses the order in that case (the operator hasn't declared
    // settings for the buyer's country yet).
    resolve: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("geolocation.resolve: input object required");
      }
      var cfCountry = _countryCode(input.cf_country, "cf_country");
      var cfRegion  = input.cf_region == null ? null : _region(input.cf_region);
      var acceptLanguage = null;
      if (input.accept_language != null) {
        if (typeof input.accept_language !== "string") {
          throw new TypeError("geolocation.resolve: accept_language must be a string");
        }
        acceptLanguage = input.accept_language;
      }
      var requestTz = null;
      if (input.timezone != null) {
        requestTz = _timezone(input.timezone, "timezone");
      }
      var supplied = null;
      if (input.customer_supplied_country != null) {
        supplied = _countryCode(input.customer_supplied_country, "customer_supplied_country");
      }

      // Buyer-supplied wins when a row exists; falls through to
      // cf_country otherwise.
      var row = null;
      if (supplied) {
        row = await _getRow(supplied);
      }
      if (!row) {
        row = await _getRow(cfCountry);
      }
      if (!row) {
        // No settings for the resolved country — the operator hasn't
        // declared this market yet. Return null so the caller can
        // surface a "we don't ship to your country" notice rather
        // than rendering a half-resolved checkout.
        return null;
      }

      var country = _rowToCountry(row);
      var locale  = _pickLocale(country.default_locale, acceptLanguage);
      var timezone = requestTz != null ? requestTz : country.default_timezone;

      var out = {
        country:                country.code,
        currency:               country.currency,
        locale:                 locale,
        geo_blocked:            country.geo_blocked,
        allowed_payment_kinds:  country.allowed_payment_kinds,
        allowed_shipping_kinds: country.allowed_shipping_kinds,
      };
      // Region is only returned when the cf_region hint was supplied
      // AND the resolved country matches the cf_country (a buyer-
      // supplied override discards the cf_region — the region is
      // meaningful only when the country it sits inside is the same
      // country the region was reported for).
      if (cfRegion != null && country.code === cfCountry) {
        out.region = cfRegion;
      }
      if (timezone != null) {
        out.timezone = timezone;
      }
      return out;
    },
  };
}

module.exports = {
  create:          create,
  COUNTRY_CODE_RE: COUNTRY_CODE_RE,
  CURRENCY_RE:     CURRENCY_RE,
  LOCALE_RE:       LOCALE_RE,
  REGION_RE:       REGION_RE,
  KIND_MAX_COUNT:  KIND_MAX_COUNT,
};
