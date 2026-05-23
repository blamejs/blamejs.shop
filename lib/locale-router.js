"use strict";
/**
 * @module shop.localeRouter
 * @title  Storefront locale routing — pick the right BCP-47 tag for
 *         an incoming request from URL prefix / subdomain / cookie /
 *         Accept-Language / customer preference.
 *
 * @intro
 *   The shop renders one storefront in many languages. An incoming
 *   request to the homepage of a multi-locale storefront answers a
 *   single question first: *which locale do I render this page in*.
 *   This primitive owns that question. The operator declares
 *
 *     - a catalog of locales (`defineLocale`) — every BCP-47 tag the
 *       storefront knows about, classified `primary` / `regional` /
 *       `variant`, with an optional `fallback` chain for when a
 *       picked locale isn't supported by the active policy and a
 *       `currency` default that downstream display primitives use
 *       to pre-fill the buyer's currency selector;
 *
 *     - a routing policy (`definePolicy`) — strategy + default
 *       locale + supported list. A storefront can carry multiple
 *       policies (marketing site, app, help center) but at most one
 *       is active at a time. `setActivePolicy(slug)` flips the
 *       active one in place; the partial-unique index in migration
 *       0139 enforces the at-most-one invariant at the SQL tier.
 *
 *   `resolveLocale({ request })` walks the request hints in a fixed
 *   precedence (which subset applies depends on the active policy's
 *   strategy):
 *
 *     1. `customer_id` -> customer_locale_prefs (when strategy ==
 *        `customer_preference`, OR for every strategy when the row
 *        exists — operators expect a logged-in buyer's explicit pick
 *        to survive across surface changes);
 *     2. URL prefix (`/en/...`, `/de/...`, `/fr-ca/...`) — strategy
 *        `url_prefix`;
 *     3. Subdomain (`de.example.com`) — strategy `subdomain`;
 *     4. Cookie (`cookie_locale`) — strategy `cookie`;
 *     5. Accept-Language q-sorted list — every strategy; the last
 *        hint before the default.
 *     6. The policy's `default_locale`.
 *
 *   Each step returns its hit only when the candidate tag is in the
 *   policy's `supported_locales` list OR when the tag's `fallback`
 *   chain (defined on the locale catalog) resolves to one that is.
 *   A request whose final resolution is the default locale records
 *   `source: "default"` even when an upstream hint was present —
 *   operators reconciling "why did this buyer see English?" should
 *   see the truthful "we walked all hints and none matched."
 *
 *   The return shape is
 *
 *     { locale: string, source: string, canonical_url?: string }
 *
 *   The `canonical_url` is emitted only for `url_prefix` and
 *   `subdomain` strategies — it's the canonical form of the
 *   request URL with the resolved locale baked in (operators stamp
 *   it into a `<link rel="canonical">` to coalesce duplicate
 *   indexing on the SEO side).
 *
 *   Composition:
 *
 *     var lr = localeRouter.create({
 *       query:    q,
 *       customers: bShop.customers,    // optional — never required
 *       geolocation: bShop.geolocation,// optional, accepted for
 *                                      // composition symmetry; the
 *                                      // primitive resolves country
 *                                      // hints only as Accept-Language
 *                                      // fallbacks.
 *     });
 *     await lr.defineLocale({ tag: "en",    kind: "primary",  currency: "USD", active: true });
 *     await lr.defineLocale({ tag: "en-US", kind: "regional", fallback: "en", currency: "USD", active: true });
 *     await lr.defineLocale({ tag: "de",    kind: "primary",  currency: "EUR", active: true });
 *     await lr.definePolicy({
 *       slug:              "main",
 *       strategy:          "url_prefix",
 *       default_locale:    "en",
 *       supported_locales: ["en", "en-US", "de"],
 *     });
 *     await lr.setActivePolicy("main");
 *     var out = await lr.resolveLocale({
 *       request: {
 *         host:            "example.com",
 *         path:            "/de/about",
 *         accept_language: "de-DE,de;q=0.9,en;q=0.5",
 *       },
 *     });
 *     // { locale: "de", source: "url_prefix",
 *     //   canonical_url: "https://example.com/de/about" }
 *
 *   Storage:
 *     - `locales_defined` + `locale_policies` +
 *       `customer_locale_prefs` + `locale_resolutions_log`
 *       (migration `0139_locale_router.sql`).
 *
 * @primitive  localeRouter
 * @related    shop.geolocation, shop.priceDisplay, shop.currencyDisplay
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var KINDS      = ["primary", "regional", "variant"];
var STRATEGIES = [
  "url_prefix",
  "subdomain",
  "cookie",
  "accept_language_only",
  "customer_preference",
];

// BCP-47 — primary language subtag (2-3 letters) plus optional
// region / script / variant subtags joined by `-`. Practical
// storefront locales fit the `lang(-Region)?` envelope; the schema
// CHECK bounds total length at 35 (IETF practical max).
var LOCALE_RE     = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
var LOCALE_MAX    = 35;
// ISO 4217 — three uppercase letters.
var CURRENCY_RE   = /^[A-Z]{3}$/;
// Slug for policy primary key — lowercase alphanumerics + dash +
// underscore, 1-80 chars.
var SLUG_RE       = /^[a-z0-9][a-z0-9_-]{0,79}$/;
// customer_id — opaque, but bounded so we don't store a megabyte by
// accident.
var CUSTOMER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
// Host — RFC 1123 subset; we accept lowercase / digit / dot / dash,
// 1-253 chars. Port is rejected (the caller strips it before
// passing in).
var HOST_RE       = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
var HOST_MAX      = 253;
// Path — `/`-prefixed, no control bytes, bounded length so we don't
// log a megabyte from a malicious caller.
var PATH_MAX      = 2048;
// Accept-Language and cookie values are bounded so a buggy upstream
// can't OOM us through the log.
var HEADER_MAX    = 4096;
var SUPPORTED_MIN = 1;
var SUPPORTED_MAX = 128;
var MAX_LIST_LIMIT = 500;
// Fallback walking — cap the chain depth so a manually-poked
// `fallback = self` loop bounces off at a deterministic point.
var FALLBACK_MAX_DEPTH = 16;

// ---- validators ---------------------------------------------------------

function _locale(s, label) {
  if (typeof s !== "string" || !LOCALE_RE.test(s) || s.length > LOCALE_MAX) {
    throw new TypeError(
      "localeRouter: " + label + " must be a BCP-47 language tag " +
      "(e.g. 'en', 'de-DE'), got " + JSON.stringify(s)
    );
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError(
      "localeRouter: kind must be one of " + KINDS.join(", ") +
      ", got " + JSON.stringify(s)
    );
  }
  return s;
}

function _strategy(s) {
  if (typeof s !== "string" || STRATEGIES.indexOf(s) === -1) {
    throw new TypeError(
      "localeRouter: strategy must be one of " + STRATEGIES.join(", ") +
      ", got " + JSON.stringify(s)
    );
  }
  return s;
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError(
      "localeRouter: currency must be a 3-letter uppercase ISO 4217 code, got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError(
      "localeRouter: slug must match /^[a-z0-9][a-z0-9_-]{0,79}$/, got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _customerId(s, label) {
  label = label || "customer_id";
  if (typeof s !== "string" || !CUSTOMER_ID_RE.test(s)) {
    throw new TypeError(
      "localeRouter: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("localeRouter: " + label + " must be a boolean");
  }
  return v;
}

function _supportedList(arr, label) {
  if (!Array.isArray(arr)) {
    throw new TypeError("localeRouter: " + label + " must be an array of locale tags");
  }
  if (arr.length < SUPPORTED_MIN || arr.length > SUPPORTED_MAX) {
    throw new TypeError(
      "localeRouter: " + label + " must contain between " + SUPPORTED_MIN +
      " and " + SUPPORTED_MAX + " entries, got " + arr.length
    );
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var t = _locale(arr[i], label + "[" + i + "]");
    if (seen[t]) {
      throw new TypeError(
        "localeRouter: " + label + " must not contain duplicate tag " +
        JSON.stringify(t)
      );
    }
    seen[t] = true;
    out.push(t);
  }
  return out;
}

function _host(s, label) {
  label = label || "host";
  if (typeof s !== "string" || !s.length || s.length > HOST_MAX) {
    throw new TypeError(
      "localeRouter: " + label + " must be a non-empty string <= " +
      HOST_MAX + " chars"
    );
  }
  // Accept `Host:` style hostnames in either case but normalise to
  // lowercase before matching; subdomain detection is case-insensitive.
  var lower = s.toLowerCase();
  // Strip an `:port` suffix defensively — operators sometimes feed in
  // the raw `Host` header, which on a non-standard port carries the
  // suffix.
  var colon = lower.indexOf(":");
  if (colon !== -1) lower = lower.slice(0, colon);
  if (!HOST_RE.test(lower)) {
    throw new TypeError(
      "localeRouter: " + label + " must be a valid hostname, got " +
      JSON.stringify(s)
    );
  }
  return lower;
}

function _path(s, label) {
  label = label || "path";
  if (typeof s !== "string" || s.length === 0 || s.length > PATH_MAX) {
    throw new TypeError(
      "localeRouter: " + label + " must be a non-empty string <= " +
      PATH_MAX + " chars"
    );
  }
  if (s.charAt(0) !== "/") {
    throw new TypeError(
      "localeRouter: " + label + " must start with '/', got " +
      JSON.stringify(s)
    );
  }
  if (/[\x00-\x1F\x7F]/.test(s)) {
    throw new TypeError("localeRouter: " + label + " must not contain control bytes");
  }
  return s;
}

function _headerOpt(s, label) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("localeRouter: " + label + " must be a string or null");
  }
  if (s.length > HEADER_MAX) {
    throw new TypeError(
      "localeRouter: " + label + " must be <= " + HEADER_MAX + " chars"
    );
  }
  if (/[\x00-\x1F\x7F]/.test(s)) {
    throw new TypeError("localeRouter: " + label + " must not contain control bytes");
  }
  return s;
}

function _limit(n, label) {
  if (n == null) return 100;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) {
    throw new TypeError(
      "localeRouter: " + label + " must be an integer in [1, " + MAX_LIST_LIMIT + "]"
    );
  }
  return n;
}

function _epochMs(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError(
      "localeRouter: " + label + " must be a non-negative integer epoch-ms, got " +
      JSON.stringify(ts)
    );
  }
  return ts;
}

// ---- accept-language parsing -------------------------------------------

// Same shape as the geolocation primitive — parse the RFC 7231
// header into a q-sorted list of `{ tag, q, order }` entries.
// Garbage entries silently drop; the worst case is an entirely
// malformed header that falls through to the next resolution step.
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
    if (!LOCALE_RE.test(tag) || tag.length > LOCALE_MAX) continue;
    parsed.push({ tag: tag, q: q, order: i });
  }
  parsed.sort(function (a, b) {
    if (a.q !== b.q) return b.q - a.q;
    return a.order - b.order;
  });
  return parsed;
}

// ---- url + subdomain extraction ----------------------------------------

// Pull the first path segment when it is shaped like a BCP-47 tag.
// Returns the lowercased tag (matching the storage convention used
// throughout — `defineLocale` preserves the operator's casing on the
// catalog row, but resolution comparisons fold both sides to lower
// case) or null when the path has no leading locale segment.
function _urlPrefixCandidate(path) {
  var rest = path.slice(1);                       // drop leading "/"
  if (!rest.length) return null;
  var slash = rest.indexOf("/");
  var seg = slash === -1 ? rest : rest.slice(0, slash);
  if (!seg.length || seg.length > LOCALE_MAX) return null;
  if (!LOCALE_RE.test(seg)) return null;
  return seg;
}

// Pull the leftmost subdomain when it is shaped like a BCP-47 tag.
// `de.example.com` -> `de`. `www.example.com` -> null (the regex
// rejects 4+ letter primary tags on the assumption that no language
// tag is longer than 3 letters in its primary subtag — keeps `www`
// / `app` / `api` from being mistaken for locales).
function _subdomainCandidate(host) {
  if (host.indexOf(".") === -1) return null;
  var first = host.slice(0, host.indexOf("."));
  if (!first.length || first.length > LOCALE_MAX) return null;
  if (!LOCALE_RE.test(first)) return null;
  return first;
}

// ---- row shaping -------------------------------------------------------

function _shapeLocale(row) {
  if (!row) return null;
  return {
    tag:          row.tag,
    kind:         row.kind,
    fallback:     row.fallback == null ? null : row.fallback,
    currency:     row.currency,
    active:       Number(row.active) === 1,
    archived_at:  row.archived_at == null ? null : Number(row.archived_at),
    created_at:   Number(row.created_at),
    updated_at:   Number(row.updated_at),
  };
}

function _shapePolicy(row) {
  if (!row) return null;
  var supported;
  try { supported = JSON.parse(row.supported_locales_json); }
  catch (_e) {
    throw new Error(
      "localeRouter: supported_locales_json column is malformed JSON — storage corruption"
    );
  }
  if (!Array.isArray(supported)) {
    throw new Error(
      "localeRouter: supported_locales_json must be a JSON array — storage corruption"
    );
  }
  return {
    slug:               row.slug,
    strategy:           row.strategy,
    default_locale:     row.default_locale,
    supported_locales:  supported,
    is_active:          Number(row.is_active) === 1,
    archived_at:        row.archived_at == null ? null : Number(row.archived_at),
    created_at:         Number(row.created_at),
    updated_at:         Number(row.updated_at),
  };
}

function _shapeCustomerPref(row) {
  if (!row) return null;
  return {
    customer_id:  row.customer_id,
    locale:       row.locale,
    set_at:       Number(row.set_at),
    updated_at:   Number(row.updated_at),
  };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  if (typeof query !== "function") {
    throw new TypeError("localeRouter.create: query must be a function");
  }
  // The `customers` and `geolocation` deps are accepted for
  // composition symmetry — the primitive validates customer ids by
  // shape (opaque string) and never round-trips through the customers
  // primitive, and it consumes geolocation hints only via the
  // request shape's existing fields. Both args are recorded so a
  // future operator-level hook can wire them without breaking this
  // signature.
  /* eslint-disable no-unused-vars */
  var customers   = opts.customers   || null;
  var geolocation = opts.geolocation || null;
  /* eslint-enable no-unused-vars */

  // Monotonic clock — per-row class. The primitive guarantees a
  // strictly-monotonic per-class updated_at sequence so a tied-
  // millisecond write doesn't lose ordering against the prior write.
  // Same shape as the currency-rounding / refund-policy clamps.
  var lastTsLocale   = Object.create(null);
  var lastTsPolicy   = Object.create(null);
  var lastTsCustomer = Object.create(null);
  // Resolutions log carries the wall-clock — monotonic per stream
  // so a busy second still orders correctly.
  var lastTsLog = 0;

  function _now() { return Date.now(); }
  function _clampLocale(tag, requested) {
    var prior = lastTsLocale[tag];
    var t = requested;
    if (prior != null && t <= prior) t = prior + 1;
    lastTsLocale[tag] = t;
    return t;
  }
  function _clampPolicy(slug, requested) {
    var prior = lastTsPolicy[slug];
    var t = requested;
    if (prior != null && t <= prior) t = prior + 1;
    lastTsPolicy[slug] = t;
    return t;
  }
  function _clampCustomer(cid, requested) {
    var prior = lastTsCustomer[cid];
    var t = requested;
    if (prior != null && t <= prior) t = prior + 1;
    lastTsCustomer[cid] = t;
    return t;
  }
  function _clampLog(requested) {
    var t = requested;
    if (t <= lastTsLog) t = lastTsLog + 1;
    lastTsLog = t;
    return t;
  }

  // ---- locale catalog ------------------------------------------------

  async function _readLocale(tag) {
    var r = await query(
      "SELECT tag, kind, fallback, currency, active, archived_at, " +
      "created_at, updated_at FROM locales_defined WHERE tag = ?1 LIMIT 1",
      [tag]
    );
    return r.rows[0] || null;
  }

  async function defineLocale(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("localeRouter.defineLocale: input object required");
    }
    var tag      = _locale(input.tag, "tag");
    var kind     = _kind(input.kind);
    var currency = _currency(input.currency);
    var active   = _bool(input.active, "active");
    var fallback = input.fallback == null ? null : _locale(input.fallback, "fallback");

    if (fallback != null) {
      if (fallback === tag) {
        throw new TypeError(
          "localeRouter.defineLocale: fallback cannot equal tag (would loop)"
        );
      }
      // Fallback must reference an existing locale row. The schema
      // doesn't FK this (D1 best-effort), so we enforce it here.
      var fbRow = await _readLocale(fallback);
      if (!fbRow) {
        throw new TypeError(
          "localeRouter.defineLocale: fallback " + JSON.stringify(fallback) +
          " does not reference a known locale"
        );
      }
    }

    var existing = await _readLocale(tag);
    var ts = _clampLocale(tag, _now());
    if (existing) {
      // Re-define-after-archive (or in-place refresh) — re-set every
      // operator-facing column. `archived_at` clears unless `active`
      // is false.
      await query(
        "UPDATE locales_defined SET kind = ?1, fallback = ?2, currency = ?3, " +
        "active = ?4, archived_at = ?5, updated_at = ?6 WHERE tag = ?7",
        [
          kind,
          fallback,
          currency,
          active ? 1 : 0,
          active ? null : ts,
          ts,
          tag,
        ]
      );
    } else {
      await query(
        "INSERT INTO locales_defined " +
        "(tag, kind, fallback, currency, active, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        [
          tag, kind, fallback, currency,
          active ? 1 : 0,
          active ? null : ts,
          ts,
        ]
      );
    }
    return _shapeLocale(await _readLocale(tag));
  }

  async function getLocale(tag) {
    return _shapeLocale(await _readLocale(_locale(tag, "tag")));
  }

  async function listLocales(input) {
    input = input || {};
    var activeOnly = input.active_only == null ? false : input.active_only;
    if (typeof activeOnly !== "boolean") {
      throw new TypeError("localeRouter.listLocales: active_only must be a boolean");
    }
    var limit = _limit(input.limit, "limit");
    var sql = "SELECT tag, kind, fallback, currency, active, archived_at, " +
              "created_at, updated_at FROM locales_defined";
    var params = [];
    if (activeOnly) sql += " WHERE active = 1";
    sql += " ORDER BY tag ASC LIMIT ?" + (params.length + 1);
    params.push(limit);
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_shapeLocale(r.rows[i]));
    return out;
  }

  // ---- policy catalog ------------------------------------------------

  async function _readPolicy(slug) {
    var r = await query(
      "SELECT slug, strategy, default_locale, supported_locales_json, " +
      "is_active, archived_at, created_at, updated_at " +
      "FROM locale_policies WHERE slug = ?1 LIMIT 1",
      [slug]
    );
    return r.rows[0] || null;
  }

  async function definePolicy(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("localeRouter.definePolicy: input object required");
    }
    var slug             = _slug(input.slug);
    var strategy         = _strategy(input.strategy);
    var defaultLocale    = _locale(input.default_locale, "default_locale");
    var supportedLocales = _supportedList(input.supported_locales, "supported_locales");

    if (supportedLocales.indexOf(defaultLocale) === -1) {
      throw new TypeError(
        "localeRouter.definePolicy: default_locale " + JSON.stringify(defaultLocale) +
        " must appear in supported_locales"
      );
    }
    // Every entry in supported_locales must reference an existing
    // locale row. Walk the list in order so the error message points
    // at the first offender deterministically.
    for (var i = 0; i < supportedLocales.length; i += 1) {
      var row = await _readLocale(supportedLocales[i]);
      if (!row) {
        throw new TypeError(
          "localeRouter.definePolicy: supported_locales[" + i + "] " +
          JSON.stringify(supportedLocales[i]) + " does not reference a known locale"
        );
      }
    }

    var existing = await _readPolicy(slug);
    var ts = _clampPolicy(slug, _now());
    var supportedJson = JSON.stringify(supportedLocales);
    if (existing) {
      // Re-define refreshes in place — but never silently flips
      // is_active. Operators flip the active policy via
      // setActivePolicy.
      await query(
        "UPDATE locale_policies SET strategy = ?1, default_locale = ?2, " +
        "supported_locales_json = ?3, archived_at = NULL, updated_at = ?4 " +
        "WHERE slug = ?5",
        [strategy, defaultLocale, supportedJson, ts, slug]
      );
    } else {
      await query(
        "INSERT INTO locale_policies " +
        "(slug, strategy, default_locale, supported_locales_json, " +
        " is_active, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, 0, NULL, ?5, ?5)",
        [slug, strategy, defaultLocale, supportedJson, ts]
      );
    }
    return _shapePolicy(await _readPolicy(slug));
  }

  async function getPolicy(slug) {
    return _shapePolicy(await _readPolicy(_slug(slug)));
  }

  async function listPolicies(input) {
    input = input || {};
    var includeArchived = input.include_archived == null ? false : input.include_archived;
    if (typeof includeArchived !== "boolean") {
      throw new TypeError("localeRouter.listPolicies: include_archived must be a boolean");
    }
    var limit = _limit(input.limit, "limit");
    var sql = "SELECT slug, strategy, default_locale, supported_locales_json, " +
              "is_active, archived_at, created_at, updated_at FROM locale_policies";
    var params = [];
    if (!includeArchived) sql += " WHERE archived_at IS NULL";
    sql += " ORDER BY slug ASC LIMIT ?" + (params.length + 1);
    params.push(limit);
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_shapePolicy(r.rows[i]));
    return out;
  }

  async function archivePolicy(slug) {
    var s = _slug(slug);
    var existing = await _readPolicy(s);
    if (!existing) {
      throw new TypeError(
        "localeRouter.archivePolicy: no policy exists for slug " + JSON.stringify(s)
      );
    }
    if (existing.archived_at != null) {
      // Idempotent: an already-archived policy re-archives as a no-op.
      return _shapePolicy(existing);
    }
    var ts = _clampPolicy(s, _now());
    // Archiving an active policy also clears is_active so the
    // partial-unique invariant holds.
    await query(
      "UPDATE locale_policies SET archived_at = ?1, is_active = 0, " +
      "updated_at = ?2 WHERE slug = ?3",
      [ts, ts, s]
    );
    return _shapePolicy(await _readPolicy(s));
  }

  // ---- active policy -------------------------------------------------

  async function setActivePolicy(slug) {
    var s = _slug(slug);
    var existing = await _readPolicy(s);
    if (!existing) {
      throw new TypeError(
        "localeRouter.setActivePolicy: no policy exists for slug " + JSON.stringify(s)
      );
    }
    if (existing.archived_at != null) {
      throw new TypeError(
        "localeRouter.setActivePolicy: cannot activate archived policy " +
        JSON.stringify(s) + " — re-define it first"
      );
    }
    var ts = _clampPolicy(s, _now());
    // Demote every other active policy first so the partial-unique
    // index never blocks the activation INSERT/UPDATE. Done in two
    // statements (D1 doesn't run transactional multi-statement
    // batches in the workflow we ship under, but the worst case is
    // an ephemeral "no active policy" window followed by the second
    // update — resolveLocale handles "no active policy" cleanly).
    await query(
      "UPDATE locale_policies SET is_active = 0, updated_at = ?1 " +
      "WHERE is_active = 1 AND slug != ?2",
      [ts, s]
    );
    await query(
      "UPDATE locale_policies SET is_active = 1, updated_at = ?1 " +
      "WHERE slug = ?2",
      [ts, s]
    );
    return _shapePolicy(await _readPolicy(s));
  }

  async function activePolicy() {
    var r = await query(
      "SELECT slug, strategy, default_locale, supported_locales_json, " +
      "is_active, archived_at, created_at, updated_at " +
      "FROM locale_policies WHERE is_active = 1 LIMIT 1",
      []
    );
    return _shapePolicy(r.rows[0] || null);
  }

  // ---- customer prefs ------------------------------------------------

  async function _readCustomerPref(customerId) {
    var r = await query(
      "SELECT customer_id, locale, set_at, updated_at " +
      "FROM customer_locale_prefs WHERE customer_id = ?1 LIMIT 1",
      [customerId]
    );
    return r.rows[0] || null;
  }

  async function setCustomerLocale(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("localeRouter.setCustomerLocale: input object required");
    }
    var customerId = _customerId(input.customer_id, "customer_id");
    var loc        = _locale(input.locale, "locale");
    // The locale must reference an existing (not necessarily active)
    // catalog row. An archived locale is allowed — operators flipping
    // a buyer's pref to a discontinued locale (audit / historical
    // replay) shouldn't be blocked.
    var row = await _readLocale(loc);
    if (!row) {
      throw new TypeError(
        "localeRouter.setCustomerLocale: locale " + JSON.stringify(loc) +
        " does not reference a known locale"
      );
    }
    var existing = await _readCustomerPref(customerId);
    var ts = _clampCustomer(customerId, _now());
    if (existing) {
      await query(
        "UPDATE customer_locale_prefs SET locale = ?1, updated_at = ?2 " +
        "WHERE customer_id = ?3",
        [loc, ts, customerId]
      );
    } else {
      await query(
        "INSERT INTO customer_locale_prefs " +
        "(customer_id, locale, set_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        [customerId, loc, ts]
      );
    }
    return _shapeCustomerPref(await _readCustomerPref(customerId));
  }

  async function clearCustomerLocale(customerId) {
    var cid = _customerId(customerId, "customer_id");
    var r = await query(
      "DELETE FROM customer_locale_prefs WHERE customer_id = ?1",
      [cid]
    );
    return { cleared: Number(r.rowCount || 0) > 0, customer_id: cid };
  }

  async function getCustomerLocale(customerId) {
    var cid = _customerId(customerId, "customer_id");
    return _shapeCustomerPref(await _readCustomerPref(cid));
  }

  // ---- resolution ----------------------------------------------------

  // Walk a candidate tag against the policy's supported list. The
  // candidate matches when:
  //   1. it appears in supported_locales (case-insensitive — BCP-47
  //      tags are case-insensitive on the wire);
  //   2. or its primary subtag matches a supported tag's primary
  //      subtag (operators who declare only `en` answer requests for
  //      `en-GB` with `en`);
  //   3. or the fallback chain on the catalog row leads to one that
  //      matches (1) or (2).
  // Returns the resolved supported tag (in its catalog casing) or
  // null when no chain reaches a supported entry.
  async function _resolveCandidate(candidate, supported) {
    if (!candidate) return null;
    var lowered = candidate.toLowerCase();
    var supportedLowerToOriginal = Object.create(null);
    for (var i = 0; i < supported.length; i += 1) {
      supportedLowerToOriginal[supported[i].toLowerCase()] = supported[i];
    }
    if (Object.prototype.hasOwnProperty.call(supportedLowerToOriginal, lowered)) {
      return supportedLowerToOriginal[lowered];
    }
    // Primary-subtag match. `en-US` candidate matches `en` supported.
    var candidatePrimary = lowered.split("-")[0];
    for (var j = 0; j < supported.length; j += 1) {
      var supportedTag = supported[j];
      var supLower = supportedTag.toLowerCase();
      if (supLower === candidatePrimary) return supportedTag;
    }
    // Walk the catalog fallback chain. Bounded depth so a manually
    // poked self-loop doesn't spin forever (the schema FK is best-
    // effort, and the application validators refuse `tag === fallback`
    // but can't refuse `A -> B -> A` without traversing the chain).
    var current = candidate;
    for (var depth = 0; depth < FALLBACK_MAX_DEPTH; depth += 1) {
      var row = await _readLocale(current);
      if (!row || row.fallback == null) return null;
      var nextLower = String(row.fallback).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(supportedLowerToOriginal, nextLower)) {
        return supportedLowerToOriginal[nextLower];
      }
      // Also check primary-subtag of the fallback hop.
      var nextPrimary = nextLower.split("-")[0];
      for (var k = 0; k < supported.length; k += 1) {
        if (supported[k].toLowerCase() === nextPrimary) return supported[k];
      }
      current = row.fallback;
    }
    return null;
  }

  function _canonicalForUrl(host, path, locale, strategy) {
    // We emit a canonical URL only for the URL-shaped strategies.
    if (strategy !== "url_prefix" && strategy !== "subdomain") return undefined;
    if (strategy === "url_prefix") {
      // Replace any leading locale-shaped path segment with the
      // resolved locale, otherwise prepend it.
      var prefix = _urlPrefixCandidate(path);
      var rest;
      if (prefix) {
        rest = path.slice(1 + prefix.length);   // strip "/<prefix>"
        if (rest.length === 0) rest = "/";
      } else {
        rest = path;
      }
      if (rest.charAt(0) !== "/") rest = "/" + rest;
      return "https://" + host + "/" + locale.toLowerCase() + (rest === "/" ? "" : rest);
    }
    // subdomain — replace any leading locale-shaped subdomain
    // segment with the resolved locale, otherwise prepend it. The
    // canonical host carries the locale subdomain even when the
    // request landed on the apex (operators expect a redirect to
    // the canonical form).
    var sub = _subdomainCandidate(host);
    var apex;
    if (sub) {
      apex = host.slice(sub.length + 1);
    } else {
      apex = host;
    }
    return "https://" + locale.toLowerCase() + "." + apex + path;
  }

  async function resolveLocale(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("localeRouter.resolveLocale: input object required");
    }
    var req = input.request;
    if (!req || typeof req !== "object") {
      throw new TypeError("localeRouter.resolveLocale: request object required");
    }
    var host = _host(req.host, "request.host");
    var path = _path(req.path, "request.path");
    var acceptLanguage = _headerOpt(req.accept_language, "request.accept_language");
    var cookieLocale   = _headerOpt(req.cookie_locale,   "request.cookie_locale");
    var customerId     = req.customer_id == null
      ? null
      : _customerId(req.customer_id, "request.customer_id");

    // Per-call validation that the cookie hint (when supplied) is
    // shaped like a locale tag — operators rotating a stale cookie
    // shouldn't crash the resolver.
    if (cookieLocale != null && (!LOCALE_RE.test(cookieLocale) || cookieLocale.length > LOCALE_MAX)) {
      cookieLocale = null;
    }

    var policy = await activePolicy();
    if (!policy) {
      // No active policy — nothing to resolve against. Operators
      // call setActivePolicy at boot; a deployment that hasn't done
      // so yet gets a clear refusal instead of a silent default.
      throw new Error(
        "localeRouter.resolveLocale: no active policy — call setActivePolicy first"
      );
    }
    var supported = policy.supported_locales;
    var strategy  = policy.strategy;
    var defaultLocale = policy.default_locale;

    // Step 1 — customer_id always wins when a row exists. Strategy
    // `customer_preference` would otherwise have no source of truth
    // other than this row; for every other strategy, an explicit
    // logged-in pick is the truthiest signal we have.
    if (customerId) {
      var pref = await _readCustomerPref(customerId);
      if (pref) {
        var custResolved = await _resolveCandidate(pref.locale, supported);
        if (custResolved) {
          return await _emitResolution(custResolved, "customer_preference", host, path, strategy);
        }
      }
    }

    // Step 2 — strategy-specific request hint.
    var hintLocale = null;
    var hintSource = null;
    if (strategy === "url_prefix") {
      hintLocale = _urlPrefixCandidate(path);
      hintSource = "url_prefix";
    } else if (strategy === "subdomain") {
      hintLocale = _subdomainCandidate(host);
      hintSource = "subdomain";
    } else if (strategy === "cookie") {
      hintLocale = cookieLocale;
      hintSource = "cookie";
    }
    if (hintLocale) {
      var hintResolved = await _resolveCandidate(hintLocale, supported);
      if (hintResolved) {
        return await _emitResolution(hintResolved, hintSource, host, path, strategy);
      }
    }

    // Step 3 — Accept-Language walk. Every strategy falls back through
    // the browser's stated preference list before landing on the
    // policy default.
    if (acceptLanguage) {
      var alEntries = _parseAcceptLanguage(acceptLanguage);
      for (var i = 0; i < alEntries.length; i += 1) {
        var alResolved = await _resolveCandidate(alEntries[i].tag, supported);
        if (alResolved) {
          return await _emitResolution(alResolved, "accept_language", host, path, strategy);
        }
      }
    }

    // Step 4 — the policy's default locale.
    return await _emitResolution(defaultLocale, "default", host, path, strategy);
  }

  async function _emitResolution(locale, source, host, path, strategy) {
    var out = { locale: locale, source: source };
    var canonical = _canonicalForUrl(host, path, locale, strategy);
    if (canonical !== undefined) out.canonical_url = canonical;

    var id = _b().uuid.v7();
    var ts = _clampLog(_now());
    await query(
      "INSERT INTO locale_resolutions_log " +
      "(id, locale, source, host, path, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [id, locale, source, host, path, ts]
    );
    return out;
  }

  // ---- popularity / audit --------------------------------------------

  async function localePopularity(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("localeRouter.localePopularity: input object required");
    }
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to,   "to");
    var limit = _limit(input.limit, "limit");
    if (from != null && to != null && from > to) {
      throw new TypeError("localeRouter.localePopularity: from must be <= to");
    }
    var sql = "SELECT locale, COUNT(*) AS hits FROM locale_resolutions_log";
    var params = [];
    var where = [];
    if (from != null) {
      where.push("occurred_at >= ?" + (params.length + 1));
      params.push(from);
    }
    if (to != null) {
      where.push("occurred_at <= ?" + (params.length + 1));
      params.push(to);
    }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " GROUP BY locale ORDER BY hits DESC, locale ASC LIMIT ?" +
           (params.length + 1);
    params.push(limit);
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      out.push({
        locale: r.rows[i].locale,
        hits:   Number(r.rows[i].hits),
      });
    }
    return out;
  }

  return {
    KINDS:               KINDS.slice(),
    STRATEGIES:          STRATEGIES.slice(),
    LOCALE_RE:           LOCALE_RE,
    CURRENCY_RE:         CURRENCY_RE,
    defineLocale:        defineLocale,
    getLocale:           getLocale,
    listLocales:         listLocales,
    definePolicy:        definePolicy,
    getPolicy:           getPolicy,
    listPolicies:        listPolicies,
    archivePolicy:       archivePolicy,
    setActivePolicy:     setActivePolicy,
    activePolicy:        activePolicy,
    setCustomerLocale:   setCustomerLocale,
    clearCustomerLocale: clearCustomerLocale,
    getCustomerLocale:   getCustomerLocale,
    resolveLocale:       resolveLocale,
    localePopularity:    localePopularity,
  };
}

module.exports = {
  create:     create,
  KINDS:      KINDS,
  STRATEGIES: STRATEGIES,
  LOCALE_RE:  LOCALE_RE,
  CURRENCY_RE: CURRENCY_RE,
};
