"use strict";
// codebase-patterns:allow-file raw-sql-identifier-interpolation — every `table` interpolation in this file is a primitive-controlled ternary literal (`kind === "manifest" ? "pwa_manifests" : "pwa_sw_configs"`); the identifier never traces back to operator / user input. Wrapping in `b.safeSql.quoteIdentifier` would be defense-in-depth but the two-element domain is already enumerated at write time.
/**
 * @module shop.pwaManifest
 * @title  PWA manifest — operator-configurable webmanifest + service worker
 *
 * @intro
 *   Owns the bytes the storefront serves at
 *   `/manifest.webmanifest` and `/sw.js` — the two artifacts a
 *   browser fetches to treat the site as a Progressive Web App
 *   (install prompt, standalone display, offline shell). Operators
 *   author both surfaces through this primitive; the worker
 *   renders the active versions on demand.
 *
 *   Manifest surface:
 *     - `defineManifest({ name, short_name, description, start_url,
 *                          scope, display, orientation, theme_color,
 *                          background_color, lang?, dir?, icons })`
 *       — append a new version row. `display` and `orientation` are
 *       closed enums (display: standalone / fullscreen / minimal-ui
 *       / browser; orientation: any / natural / portrait /
 *       landscape). Colors must be lowercase `#rrggbb` 6-digit hex —
 *       any other shape (3-digit hex, named colors, `rgb(...)`) is
 *       refused so the byte-level output is predictable across
 *       browsers. `start_url` + `scope` are validated through
 *       `b.safeUrl.parse` (https-only) when absolute or pass the
 *       `/`-rooted absolute-path allow-list (the common case — the
 *       manifest references the site's own routes). `icons` is an
 *       array of `{ src, sizes, type, purpose? }` descriptors that
 *       passes through `validateIcons` before storage.
 *
 *     - `getActive()` — the currently-active manifest row (or null
 *       when no version has been activated yet).
 *
 *     - `setActive(versionNumber)` — flip the active flag to the
 *       named version inside a single sweep. The prior active row
 *       drops to `is_active=0`. Archived versions can not become
 *       active.
 *
 *     - `listVersions({ cursor?, limit? })` — paginate the version
 *       history newest-first. Cursor is HMAC-tagged via
 *       `b.pagination.encodeCursor` so a tampered cursor refuses.
 *
 *     - `archiveVersion(versionNumber)` — soft-delete a version.
 *       Archiving the active version clears the active flag (no
 *       archived version can stay active).
 *
 *     - `renderManifestJson()` — emit the JSON bytes for
 *       `/manifest.webmanifest`. The output is a deterministic
 *       JSON.stringify (sorted keys, two-space indent) so a byte-
 *       diff between releases reflects an operator edit rather
 *       than serializer noise.
 *
 *     - `validateIcons(icons)` — exposed icon validation entry
 *       point. Operators previewing icon arrays before
 *       defineManifest call this directly.
 *
 *   Service-worker surface:
 *     - `defineServiceWorkerConfig({ cache_name, precache_urls,
 *                                     runtime_rules, offline_fallback?,
 *                                     navigation_fallback? })` —
 *       append a new SW config version. `cache_name` namespaces
 *       the caches so two parallel SW versions don't collide
 *       during a rollout. `precache_urls` is the URL list cached
 *       on `install`. `runtime_rules` is an array of
 *       `{ url_pattern, strategy }` entries (strategy: cache-first
 *       / network-first / stale-while-revalidate / network-only).
 *
 *     - Companion `getActive('sw')` / `setActive('sw', version)` /
 *       `listVersions('sw', ...)` / `archiveVersion('sw', version)`
 *       overloads route the same lifecycle to the SW table. The
 *       default scope when omitted is `'manifest'`.
 *
 *     - `renderServiceWorkerJs()` — emit the JS bytes for `/sw.js`.
 *       The body is a self-contained `addEventListener('install', …)`
 *       / `addEventListener('fetch', …)` script that reads the
 *       active SW config row. Operator-sourced URL fragments are
 *       JSON.stringify'd into the body so a hostile URL can't
 *       break out of the string literal.
 *
 *   Composes ONLY blamejs:
 *     - `b.framework.safeUrl.parse`     — start_url / scope / icon src
 *                                          validation (https-only absolute).
 *     - `b.framework.uuid.v7`            — row ids.
 *     - `b.framework.pagination`         — listVersions cursor (HMAC-tagged).
 *
 *   Monotonic per-process clock — two writes in the same millisecond
 *   would tie on `updated_at` and make a sort-by-timestamp read
 *   ambiguous. `_now` bumps to `prior + 1` on collision so the
 *   timeline stays strictly increasing.
 *
 *   Storage:
 *     - `pwa_manifests`  — versioned manifest rows.
 *     - `pwa_sw_configs` — versioned SW config rows.
 *     (migration `0168_pwa_manifest.sql`)
 *
 * @primitive pwaManifest
 * @related    b.safeUrl.parse, b.uuid.v7, b.pagination
 */

// ---- enums -------------------------------------------------------------

var ALLOWED_DISPLAYS = Object.freeze([
  "standalone",
  "fullscreen",
  "minimal-ui",
  "browser",
]);

var ALLOWED_ORIENTATIONS = Object.freeze([
  "any",
  "natural",
  "portrait",
  "landscape",
]);

var ALLOWED_DIRS = Object.freeze(["ltr", "rtl", "auto"]);

var ALLOWED_STRATEGIES = Object.freeze([
  "cache-first",
  "network-first",
  "stale-while-revalidate",
  "network-only",
]);

var ALLOWED_ICON_PURPOSES = Object.freeze(["any", "maskable", "monochrome"]);

var ALLOWED_SCOPES = Object.freeze(["manifest", "sw"]);

// ---- bounds ------------------------------------------------------------

var MAX_NAME_LEN          = 200;
var MAX_SHORT_NAME_LEN    = 60;
var MAX_DESCRIPTION_LEN   = 1024;
var MAX_URL_LEN           = 2048;
var MAX_LANG_LEN          = 35;
var MAX_CACHE_NAME_LEN    = 120;
var MAX_ICON_COUNT        = 32;
var MAX_ICON_SIZES_LEN    = 200;
var MAX_ICON_TYPE_LEN     = 80;
var MAX_PRECACHE_URLS     = 256;
var MAX_RUNTIME_RULES     = 64;
var MAX_URL_PATTERN_LEN   = 256;
var MAX_LIST_LIMIT        = 100;
var DEFAULT_LIST_LIMIT    = 25;

// ---- regexes -----------------------------------------------------------

// Lowercase 6-digit hex only. 3-digit shorthand, named colors,
// rgb()/hsl()/hwb(), and uppercase are refused so the rendered
// bytes are predictable across user agents (some Android Chrome
// flavors render `#fff` differently from `#FFFFFF`).
var HEX_COLOR_RE = /^#[0-9a-f]{6}$/;

// BCP-47 tag — same shape as knowledgeBase / emailTemplates.
var LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

// Cache name — alnum + dot + hyphen + underscore. Reaches the
// rendered SW body inside a JSON.stringify, but a narrow cache
// name keeps the operator-visible value grep-friendly.
var CACHE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,118}[a-z0-9]$|^[a-z0-9]$/;

// Icon sizes — one or more space-separated `WxH` or `any` tokens.
// e.g. `192x192`, `512x512`, `192x192 512x512`, `any`.
var ICON_SIZES_RE = /^(?:any|\d+x\d+)(?:\s+(?:any|\d+x\d+))*$/;

// MIME type — narrow shape covering the icon types the manifest
// spec recommends (image/png / image/svg+xml / image/webp).
var ICON_TYPE_RE = /^[a-z]+\/[a-z0-9.+-]+$/;

var CONTROL_BYTE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- monotonic clock ---------------------------------------------------
//
// Two writes in the same millisecond would tie on `updated_at`.
// Bump by 1 on collision so the listVersions sort is strictly
// increasing.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _string(s, label, max) {
  if (typeof s !== "string") {
    throw new TypeError("pwaManifest: " + label + " must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("pwaManifest: " + label + " must be non-empty after trim");
  }
  if (s.length > max) {
    throw new TypeError("pwaManifest: " + label + " must be <= " + max + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("pwaManifest: " + label + " contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("pwaManifest: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

function _hexColor(s, label) {
  if (typeof s !== "string") {
    throw new TypeError("pwaManifest: " + label + " must be a string");
  }
  if (!HEX_COLOR_RE.test(s)) {
    throw new TypeError(
      "pwaManifest: " + label + " must be a lowercase 6-digit hex color like '#1a2b3c' " +
      "(3-digit shorthand, uppercase, rgb()/hsl(), and named colors are refused)"
    );
  }
  return s;
}

function _enum(s, allowed, label) {
  if (typeof s !== "string" || allowed.indexOf(s) === -1) {
    throw new TypeError("pwaManifest: " + label + " must be one of " + JSON.stringify(allowed));
  }
  return s;
}

function _lang(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pwaManifest: lang must be a non-empty string");
  }
  if (s.length > MAX_LANG_LEN) {
    throw new TypeError("pwaManifest: lang must be <= " + MAX_LANG_LEN + " characters");
  }
  var lower = s.toLowerCase();
  if (!LANG_RE.test(lower)) {
    throw new TypeError("pwaManifest: lang must be a BCP-47 tag (e.g. 'en', 'fr-ca')");
  }
  return lower;
}

function _cacheName(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pwaManifest: cache_name must be a non-empty string");
  }
  if (s.length > MAX_CACHE_NAME_LEN) {
    throw new TypeError("pwaManifest: cache_name must be <= " + MAX_CACHE_NAME_LEN + " characters");
  }
  if (!CACHE_NAME_RE.test(s)) {
    throw new TypeError("pwaManifest: cache_name must match /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/");
  }
  return s;
}

// URL validation. A manifest's start_url / scope / icon src is
// either an absolute https:// URL (validated through b.safeUrl) OR
// a `/`-rooted absolute path on the same origin. Protocol-relative
// `//host` and `..`-bearing paths are refused so a hostile value
// can't smuggle a navigation off-origin.
function _url(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("pwaManifest: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_URL_LEN) {
    throw new TypeError("pwaManifest: " + label + " must be <= " + MAX_URL_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("pwaManifest: " + label + " contains control / zero-width bytes");
  }
  if (s.charCodeAt(0) === 47 /* "/" */) {
    if (s.length > 1 && s.charCodeAt(1) === 47) {
      throw new TypeError("pwaManifest: " + label + " must not start with '//' (protocol-relative)");
    }
    if (s.indexOf("..") !== -1) {
      throw new TypeError("pwaManifest: " + label + " must not contain '..'");
    }
    return s;
  }
  try {
    _b().safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError(
      "pwaManifest: " + label + " — " + (e && e.message || "must be a /-rooted path or https:// URL")
    );
  }
  return s;
}

function _scopeKind(s) {
  if (s == null) return "manifest";
  if (typeof s !== "string" || ALLOWED_SCOPES.indexOf(s) === -1) {
    throw new TypeError("pwaManifest: scope kind must be one of " + JSON.stringify(ALLOWED_SCOPES));
  }
  return s;
}

function _versionNumber(n, label) {
  if (!Number.isInteger(n) || n < 1) {
    throw new TypeError("pwaManifest: " + label + " must be a positive integer");
  }
  return n;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("pwaManifest: limit must be an integer 1..." + MAX_LIST_LIMIT);
  }
  return n;
}

// ---- icon validation ---------------------------------------------------
//
// Each icon descriptor: { src, sizes, type, purpose? }. The src is
// gated by `_url`; sizes match the manifest spec's `WxH` shape or
// `any`; type is a narrow MIME shape; purpose (when present) is an
// enum. Duplicates are refused so an operator can't ship two
// conflicting descriptors for the same (sizes, purpose) tuple.

function _validateIcons(icons) {
  if (!Array.isArray(icons)) {
    throw new TypeError("pwaManifest: icons must be an array of { src, sizes, type, purpose? } descriptors");
  }
  if (!icons.length) {
    throw new TypeError("pwaManifest: icons must contain at least one descriptor");
  }
  if (icons.length > MAX_ICON_COUNT) {
    throw new TypeError("pwaManifest: icons must contain <= " + MAX_ICON_COUNT + " entries");
  }
  var seen = {};
  var out = [];
  for (var i = 0; i < icons.length; i += 1) {
    var ic = icons[i];
    if (!ic || typeof ic !== "object") {
      throw new TypeError("pwaManifest: icons[" + i + "] must be an object");
    }
    var src = _url(ic.src, "icons[" + i + "].src");
    if (typeof ic.sizes !== "string" || !ic.sizes.length) {
      throw new TypeError("pwaManifest: icons[" + i + "].sizes must be a non-empty string");
    }
    if (ic.sizes.length > MAX_ICON_SIZES_LEN) {
      throw new TypeError("pwaManifest: icons[" + i + "].sizes must be <= " + MAX_ICON_SIZES_LEN + " characters");
    }
    if (!ICON_SIZES_RE.test(ic.sizes)) {
      throw new TypeError(
        "pwaManifest: icons[" + i + "].sizes must be space-separated 'WxH' tokens or 'any' " +
        "(e.g. '192x192 512x512')"
      );
    }
    if (typeof ic.type !== "string" || !ic.type.length) {
      throw new TypeError("pwaManifest: icons[" + i + "].type must be a non-empty string");
    }
    if (ic.type.length > MAX_ICON_TYPE_LEN) {
      throw new TypeError("pwaManifest: icons[" + i + "].type must be <= " + MAX_ICON_TYPE_LEN + " characters");
    }
    if (!ICON_TYPE_RE.test(ic.type)) {
      throw new TypeError("pwaManifest: icons[" + i + "].type must be a MIME type (e.g. 'image/png')");
    }
    var purpose;
    if (ic.purpose == null) {
      purpose = "any";
    } else if (typeof ic.purpose !== "string" || ALLOWED_ICON_PURPOSES.indexOf(ic.purpose) === -1) {
      throw new TypeError(
        "pwaManifest: icons[" + i + "].purpose must be one of " + JSON.stringify(ALLOWED_ICON_PURPOSES)
      );
    } else {
      purpose = ic.purpose;
    }
    var key = ic.sizes + "|" + purpose;
    if (seen[key]) {
      throw new TypeError(
        "pwaManifest: icons[" + i + "] duplicates an earlier (sizes='" + ic.sizes +
        "', purpose='" + purpose + "') descriptor"
      );
    }
    seen[key] = 1;
    out.push({ src: src, sizes: ic.sizes, type: ic.type, purpose: purpose });
  }
  return out;
}

// ---- runtime-rule validation ------------------------------------------
//
// Each runtime rule: { url_pattern, strategy }. `url_pattern` is a
// narrow string (no control bytes / no zero-width). `strategy` is
// a closed enum so the rendered SW body has a known finite branch
// surface. Duplicate url_patterns are refused so the operator's
// rule table is internally consistent.

function _validateRuntimeRules(rules) {
  if (!Array.isArray(rules)) {
    throw new TypeError("pwaManifest: runtime_rules must be an array");
  }
  if (rules.length > MAX_RUNTIME_RULES) {
    throw new TypeError("pwaManifest: runtime_rules must contain <= " + MAX_RUNTIME_RULES + " entries");
  }
  var seen = {};
  var out = [];
  for (var i = 0; i < rules.length; i += 1) {
    var r = rules[i];
    if (!r || typeof r !== "object") {
      throw new TypeError("pwaManifest: runtime_rules[" + i + "] must be an object");
    }
    if (typeof r.url_pattern !== "string" || !r.url_pattern.length) {
      throw new TypeError("pwaManifest: runtime_rules[" + i + "].url_pattern must be a non-empty string");
    }
    if (r.url_pattern.length > MAX_URL_PATTERN_LEN) {
      throw new TypeError(
        "pwaManifest: runtime_rules[" + i + "].url_pattern must be <= " +
        MAX_URL_PATTERN_LEN + " characters"
      );
    }
    if (CONTROL_BYTE_RE.test(r.url_pattern) || ZERO_WIDTH_RE.test(r.url_pattern)) {
      throw new TypeError(
        "pwaManifest: runtime_rules[" + i + "].url_pattern contains control / zero-width bytes"
      );
    }
    _enum(r.strategy, ALLOWED_STRATEGIES, "runtime_rules[" + i + "].strategy");
    if (seen[r.url_pattern]) {
      throw new TypeError(
        "pwaManifest: runtime_rules[" + i + "] duplicates url_pattern " + JSON.stringify(r.url_pattern)
      );
    }
    seen[r.url_pattern] = 1;
    out.push({ url_pattern: r.url_pattern, strategy: r.strategy });
  }
  return out;
}

function _validatePrecacheUrls(urls) {
  if (!Array.isArray(urls)) {
    throw new TypeError("pwaManifest: precache_urls must be an array");
  }
  if (urls.length > MAX_PRECACHE_URLS) {
    throw new TypeError("pwaManifest: precache_urls must contain <= " + MAX_PRECACHE_URLS + " entries");
  }
  var seen = {};
  var out = [];
  for (var i = 0; i < urls.length; i += 1) {
    var u = _url(urls[i], "precache_urls[" + i + "]");
    if (seen[u]) {
      throw new TypeError("pwaManifest: precache_urls[" + i + "] duplicates an earlier entry");
    }
    seen[u] = 1;
    out.push(u);
  }
  return out;
}

// ---- hydration ---------------------------------------------------------

function _hydrateManifest(row) {
  if (!row) return null;
  var icons;
  try { icons = JSON.parse(row.icons_json || "[]"); }
  catch (_e) { icons = []; }
  return {
    id:               row.id,
    version_number:   Number(row.version_number),
    name:             row.name,
    short_name:       row.short_name,
    description:      row.description,
    start_url:        row.start_url,
    scope:            row.scope,
    display:          row.display,
    orientation:      row.orientation,
    theme_color:      row.theme_color,
    background_color: row.background_color,
    lang:             row.lang,
    dir:              row.dir,
    icons:            icons,
    is_active:        row.is_active === 1 || row.is_active === true,
    archived_at:      row.archived_at == null ? null : Number(row.archived_at),
    created_at:       Number(row.created_at),
    updated_at:       Number(row.updated_at),
  };
}

function _hydrateSwConfig(row) {
  if (!row) return null;
  var precache;
  try { precache = JSON.parse(row.precache_urls_json || "[]"); }
  catch (_e) { precache = []; }
  var runtime;
  try { runtime = JSON.parse(row.runtime_rules_json || "[]"); }
  catch (_e) { runtime = []; }
  return {
    id:                  row.id,
    version_number:      Number(row.version_number),
    cache_name:          row.cache_name,
    precache_urls:       precache,
    runtime_rules:       runtime,
    offline_fallback:    row.offline_fallback == null ? null : row.offline_fallback,
    navigation_fallback: row.navigation_fallback == null ? null : row.navigation_fallback,
    is_active:           row.is_active === 1 || row.is_active === true,
    archived_at:         row.archived_at == null ? null : Number(row.archived_at),
    created_at:          Number(row.created_at),
    updated_at:          Number(row.updated_at),
  };
}

// ---- deterministic JSON serialization ---------------------------------
//
// `JSON.stringify(obj, replacer, 2)` orders keys by insertion. A
// byte-stable manifest output needs a sorted-key serializer so a
// `git diff` of two releases reflects an operator edit rather than
// JavaScript's object-property iteration order.

function _stableStringify(value, indent) {
  function _walk(v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      var arr = [];
      for (var i = 0; i < v.length; i += 1) arr.push(_walk(v[i]));
      return arr;
    }
    var keys = Object.keys(v).sort();
    var obj = {};
    for (var k = 0; k < keys.length; k += 1) {
      obj[keys[k]] = _walk(v[keys[k]]);
    }
    return obj;
  }
  return JSON.stringify(_walk(value), null, indent);
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("pwaManifest.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "pwa-manifest-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  var MANIFEST_ORDER_KEY = ["version_number:desc"];
  var SW_ORDER_KEY       = ["version_number:desc"];

  function _decodeCursor(cursor, label, orderKey) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("pwaManifest." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = _b().pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(orderKey)) {
        throw new TypeError("pwaManifest." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("pwaManifest." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNext(rows, limit, orderKey) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return _b().pagination.encodeCursor({
      orderKey: orderKey,
      vals:     [Number(last.version_number)],
      forward:  true,
    }, cursorSecret);
  }

  // Compute next version_number for the given table. Reading the
  // MAX is fine — the table's UNIQUE(version_number) catches a
  // hypothetical concurrent insert and the lib layer is single-
  // writer in the worker by construction.
  async function _nextVersion(table) {
    var r = await query(
      "SELECT MAX(version_number) AS mx FROM " + table,
      [],
    );
    var mx = r.rows[0] && r.rows[0].mx;
    return (mx == null ? 0 : Number(mx)) + 1;
  }

  // ---- defineManifest ----------------------------------------------------

  async function defineManifest(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("pwaManifest.defineManifest: input object required");
    }
    var name             = _string(input.name, "name", MAX_NAME_LEN);
    var shortName        = _string(input.short_name, "short_name", MAX_SHORT_NAME_LEN);
    var description      = _string(input.description, "description", MAX_DESCRIPTION_LEN);
    var startUrl         = _url(input.start_url, "start_url");
    var scopeUrl         = _url(input.scope, "scope");
    var display          = _enum(input.display, ALLOWED_DISPLAYS, "display");
    var orientation      = _enum(input.orientation, ALLOWED_ORIENTATIONS, "orientation");
    var themeColor       = _hexColor(input.theme_color, "theme_color");
    var backgroundColor  = _hexColor(input.background_color, "background_color");
    var lang             = input.lang == null ? "en" : _lang(input.lang);
    var dir              = input.dir  == null ? "auto" : _enum(input.dir, ALLOWED_DIRS, "dir");
    var icons            = _validateIcons(input.icons);

    var versionNumber = await _nextVersion("pwa_manifests");
    var ts = _now();
    var id = _b().uuid.v7();

    await query(
      "INSERT INTO pwa_manifests " +
      "(id, version_number, name, short_name, description, start_url, scope, " +
      " display, orientation, theme_color, background_color, lang, dir, icons_json, " +
      " is_active, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 0, NULL, ?15, ?15)",
      [
        id, versionNumber, name, shortName, description, startUrl, scopeUrl,
        display, orientation, themeColor, backgroundColor, lang, dir,
        JSON.stringify(icons), ts,
      ],
    );

    var r = await query(
      "SELECT * FROM pwa_manifests WHERE version_number = ?1",
      [versionNumber],
    );
    return _hydrateManifest(r.rows[0]);
  }

  // ---- defineServiceWorkerConfig ----------------------------------------

  async function defineServiceWorkerConfig(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("pwaManifest.defineServiceWorkerConfig: input object required");
    }
    var cacheName    = _cacheName(input.cache_name);
    var precacheUrls = _validatePrecacheUrls(input.precache_urls == null ? [] : input.precache_urls);
    var runtimeRules = _validateRuntimeRules(input.runtime_rules == null ? [] : input.runtime_rules);
    var offlineFallback    = null;
    var navigationFallback = null;
    if (input.offline_fallback != null) {
      offlineFallback = _url(input.offline_fallback, "offline_fallback");
    }
    if (input.navigation_fallback != null) {
      navigationFallback = _url(input.navigation_fallback, "navigation_fallback");
    }

    var versionNumber = await _nextVersion("pwa_sw_configs");
    var ts = _now();
    var id = _b().uuid.v7();

    await query(
      "INSERT INTO pwa_sw_configs " +
      "(id, version_number, cache_name, precache_urls_json, runtime_rules_json, " +
      " offline_fallback, navigation_fallback, is_active, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, ?8, ?8)",
      [
        id, versionNumber, cacheName, JSON.stringify(precacheUrls), JSON.stringify(runtimeRules),
        offlineFallback, navigationFallback, ts,
      ],
    );

    var r = await query(
      "SELECT * FROM pwa_sw_configs WHERE version_number = ?1",
      [versionNumber],
    );
    return _hydrateSwConfig(r.rows[0]);
  }

  // ---- getActive ---------------------------------------------------------

  async function getActive(kind) {
    var k = _scopeKind(kind);
    if (k === "manifest") {
      var r = await query(
        "SELECT * FROM pwa_manifests WHERE is_active = 1 AND archived_at IS NULL LIMIT 1",
        [],
      );
      return _hydrateManifest(r.rows[0] || null);
    }
    var rs = await query(
      "SELECT * FROM pwa_sw_configs WHERE is_active = 1 AND archived_at IS NULL LIMIT 1",
      [],
    );
    return _hydrateSwConfig(rs.rows[0] || null);
  }

  // ---- setActive ---------------------------------------------------------

  async function setActive(arg1, arg2) {
    // Two call shapes:
    //   setActive(versionNumber)            → manifest scope
    //   setActive(kind, versionNumber)      → explicit scope
    var kind, versionNumber;
    if (arg2 === undefined) {
      kind = "manifest";
      versionNumber = arg1;
    } else {
      kind = _scopeKind(arg1);
      versionNumber = arg2;
    }
    versionNumber = _versionNumber(versionNumber, "version_number");

    var table = kind === "manifest" ? "pwa_manifests" : "pwa_sw_configs";

    var r = await query(
      "SELECT * FROM " + table + " WHERE version_number = ?1",
      [versionNumber],
    );
    var row = r.rows[0];
    if (!row) {
      var err = new Error(
        "pwaManifest.setActive: " + kind + " version " + versionNumber + " not found"
      );
      err.code = "PWA_VERSION_NOT_FOUND";
      throw err;
    }
    if (row.archived_at != null) {
      var aErr = new Error(
        "pwaManifest.setActive: " + kind + " version " + versionNumber + " is archived"
      );
      aErr.code = "PWA_VERSION_ARCHIVED";
      throw aErr;
    }
    var ts = _now();
    await query(
      "UPDATE " + table + " SET is_active = 0, updated_at = ?1 " +
      "WHERE is_active = 1 AND version_number != ?2",
      [ts, versionNumber],
    );
    await query(
      "UPDATE " + table + " SET is_active = 1, updated_at = ?1 " +
      "WHERE version_number = ?2",
      [ts, versionNumber],
    );
    var fresh = await query(
      "SELECT * FROM " + table + " WHERE version_number = ?1",
      [versionNumber],
    );
    return kind === "manifest"
      ? _hydrateManifest(fresh.rows[0])
      : _hydrateSwConfig(fresh.rows[0]);
  }

  // ---- listVersions ------------------------------------------------------

  async function listVersions(arg1, arg2) {
    // Two call shapes:
    //   listVersions(opts)                  → manifest scope
    //   listVersions(kind, opts)            → explicit scope
    var kind, listOpts;
    if (arg2 === undefined) {
      if (typeof arg1 === "string") {
        kind = _scopeKind(arg1);
        listOpts = {};
      } else {
        kind = "manifest";
        listOpts = arg1 || {};
      }
    } else {
      kind = _scopeKind(arg1);
      listOpts = arg2 || {};
    }

    var table    = kind === "manifest" ? "pwa_manifests" : "pwa_sw_configs";
    var orderKey = kind === "manifest" ? MANIFEST_ORDER_KEY : SW_ORDER_KEY;
    var limit    = _limit(listOpts.limit);
    var cursorVals = _decodeCursor(listOpts.cursor, "listVersions", orderKey);

    var where  = ["1 = 1"];
    var params = [];
    var idx    = 1;
    if (cursorVals) {
      where.push("version_number < ?" + idx);
      params.push(cursorVals[0]);
      idx += 1;
    }
    params.push(limit);
    var sql = "SELECT * FROM " + table + " WHERE " + where.join(" AND ") +
              " ORDER BY version_number DESC LIMIT ?" + idx;
    var r = await query(sql, params);
    var rows = r.rows.map(kind === "manifest" ? _hydrateManifest : _hydrateSwConfig);
    return { rows: rows, next_cursor: _encodeNext(r.rows, limit, orderKey) };
  }

  // ---- archiveVersion ----------------------------------------------------

  async function archiveVersion(arg1, arg2) {
    var kind, versionNumber;
    if (arg2 === undefined) {
      kind = "manifest";
      versionNumber = arg1;
    } else {
      kind = _scopeKind(arg1);
      versionNumber = arg2;
    }
    versionNumber = _versionNumber(versionNumber, "version_number");

    var table = kind === "manifest" ? "pwa_manifests" : "pwa_sw_configs";

    var r = await query(
      "SELECT * FROM " + table + " WHERE version_number = ?1",
      [versionNumber],
    );
    var row = r.rows[0];
    if (!row) {
      var err = new Error(
        "pwaManifest.archiveVersion: " + kind + " version " + versionNumber + " not found"
      );
      err.code = "PWA_VERSION_NOT_FOUND";
      throw err;
    }
    if (row.archived_at != null) {
      return kind === "manifest" ? _hydrateManifest(row) : _hydrateSwConfig(row);
    }
    var ts = _now();
    await query(
      "UPDATE " + table + " SET archived_at = ?1, is_active = 0, updated_at = ?1 " +
      "WHERE version_number = ?2",
      [ts, versionNumber],
    );
    var fresh = await query(
      "SELECT * FROM " + table + " WHERE version_number = ?1",
      [versionNumber],
    );
    return kind === "manifest"
      ? _hydrateManifest(fresh.rows[0])
      : _hydrateSwConfig(fresh.rows[0]);
  }

  // ---- renderManifestJson ------------------------------------------------

  async function renderManifestJson() {
    var active = await getActive("manifest");
    if (!active) {
      var err = new Error("pwaManifest.renderManifestJson: no active manifest");
      err.code = "PWA_NO_ACTIVE_MANIFEST";
      throw err;
    }
    var manifestObj = {
      name:             active.name,
      short_name:       active.short_name,
      description:      active.description,
      start_url:        active.start_url,
      scope:            active.scope,
      display:          active.display,
      orientation:      active.orientation,
      theme_color:      active.theme_color,
      background_color: active.background_color,
      lang:             active.lang,
      dir:              active.dir,
      icons:            active.icons,
    };
    return _stableStringify(manifestObj, 2);
  }

  // ---- renderServiceWorkerJs ---------------------------------------------
  //
  // Emit the JS bytes for `/sw.js`. The body is a self-contained
  // script — install handler precaches the operator's URL list,
  // fetch handler dispatches per-rule. Operator-sourced URLs and
  // patterns are JSON.stringify'd into the body so a hostile URL
  // can't break out of the string literal.

  async function renderServiceWorkerJs() {
    var active = await getActive("sw");
    if (!active) {
      var err = new Error("pwaManifest.renderServiceWorkerJs: no active service-worker config");
      err.code = "PWA_NO_ACTIVE_SW";
      throw err;
    }
    var lines = [];
    lines.push("// service worker generated by shop.pwaManifest");
    lines.push("// cache_name=" + JSON.stringify(active.cache_name) +
               " version=" + active.version_number);
    lines.push('"use strict";');
    lines.push("var CACHE_NAME = " + JSON.stringify(active.cache_name) + ";");
    lines.push("var PRECACHE_URLS = " + JSON.stringify(active.precache_urls) + ";");
    lines.push("var RUNTIME_RULES = " + JSON.stringify(active.runtime_rules) + ";");
    lines.push("var OFFLINE_FALLBACK = " +
      (active.offline_fallback == null ? "null" : JSON.stringify(active.offline_fallback)) + ";");
    lines.push("var NAVIGATION_FALLBACK = " +
      (active.navigation_fallback == null ? "null" : JSON.stringify(active.navigation_fallback)) + ";");
    lines.push("self.addEventListener('install', function (e) {");
    lines.push("  e.waitUntil(caches.open(CACHE_NAME).then(function (c) {");
    lines.push("    return c.addAll(PRECACHE_URLS);");
    lines.push("  }).then(function () { return self.skipWaiting(); }));");
    lines.push("});");
    lines.push("self.addEventListener('activate', function (e) {");
    lines.push("  e.waitUntil(caches.keys().then(function (keys) {");
    lines.push("    return Promise.all(keys.map(function (k) {");
    lines.push("      if (k !== CACHE_NAME) return caches.delete(k);");
    lines.push("    }));");
    lines.push("  }).then(function () { return self.clients.claim(); }));");
    lines.push("});");
    lines.push("function _matchRule(url) {");
    lines.push("  for (var i = 0; i < RUNTIME_RULES.length; i += 1) {");
    lines.push("    if (url.indexOf(RUNTIME_RULES[i].url_pattern) !== -1) return RUNTIME_RULES[i];");
    lines.push("  }");
    lines.push("  return null;");
    lines.push("}");
    lines.push("function _cacheFirst(req) {");
    lines.push("  return caches.match(req).then(function (hit) {");
    lines.push("    return hit || fetch(req).then(function (res) {");
    lines.push("      var copy = res.clone();");
    lines.push("      caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });");
    lines.push("      return res;");
    lines.push("    });");
    lines.push("  });");
    lines.push("}");
    lines.push("function _networkFirst(req) {");
    lines.push("  return fetch(req).then(function (res) {");
    lines.push("    var copy = res.clone();");
    lines.push("    caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });");
    lines.push("    return res;");
    lines.push("  }).catch(function () { return caches.match(req); });");
    lines.push("}");
    lines.push("function _staleWhileRevalidate(req) {");
    lines.push("  var hit = caches.match(req);");
    lines.push("  var net = fetch(req).then(function (res) {");
    lines.push("    var copy = res.clone();");
    lines.push("    caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });");
    lines.push("    return res;");
    lines.push("  }).catch(function () { return null; });");
    lines.push("  return hit.then(function (h) { return h || net; });");
    lines.push("}");
    lines.push("self.addEventListener('fetch', function (e) {");
    lines.push("  if (e.request.method !== 'GET') return;");
    lines.push("  var url = e.request.url;");
    lines.push("  var rule = _matchRule(url);");
    lines.push("  if (rule) {");
    lines.push("    if (rule.strategy === 'cache-first')             { e.respondWith(_cacheFirst(e.request));            return; }");
    lines.push("    if (rule.strategy === 'network-first')           { e.respondWith(_networkFirst(e.request));          return; }");
    lines.push("    if (rule.strategy === 'stale-while-revalidate')  { e.respondWith(_staleWhileRevalidate(e.request));  return; }");
    lines.push("    /* network-only: fall through to default fetch */");
    lines.push("  }");
    lines.push("  if (e.request.mode === 'navigate' && NAVIGATION_FALLBACK) {");
    lines.push("    e.respondWith(fetch(e.request).catch(function () {");
    lines.push("      return caches.match(NAVIGATION_FALLBACK);");
    lines.push("    }));");
    lines.push("    return;");
    lines.push("  }");
    lines.push("  if (OFFLINE_FALLBACK) {");
    lines.push("    e.respondWith(fetch(e.request).catch(function () {");
    lines.push("      return caches.match(OFFLINE_FALLBACK);");
    lines.push("    }));");
    lines.push("  }");
    lines.push("});");
    return lines.join("\n") + "\n";
  }

  return {
    ALLOWED_DISPLAYS:       ALLOWED_DISPLAYS,
    ALLOWED_ORIENTATIONS:   ALLOWED_ORIENTATIONS,
    ALLOWED_DIRS:           ALLOWED_DIRS,
    ALLOWED_STRATEGIES:     ALLOWED_STRATEGIES,
    ALLOWED_ICON_PURPOSES:  ALLOWED_ICON_PURPOSES,
    ALLOWED_SCOPES:         ALLOWED_SCOPES,
    MAX_NAME_LEN:           MAX_NAME_LEN,
    MAX_SHORT_NAME_LEN:     MAX_SHORT_NAME_LEN,
    MAX_DESCRIPTION_LEN:    MAX_DESCRIPTION_LEN,
    MAX_URL_LEN:            MAX_URL_LEN,
    MAX_ICON_COUNT:         MAX_ICON_COUNT,
    MAX_PRECACHE_URLS:      MAX_PRECACHE_URLS,
    MAX_RUNTIME_RULES:      MAX_RUNTIME_RULES,
    MAX_LIST_LIMIT:         MAX_LIST_LIMIT,

    defineManifest:              defineManifest,
    defineServiceWorkerConfig:   defineServiceWorkerConfig,
    getActive:                   getActive,
    setActive:                   setActive,
    renderManifestJson:          renderManifestJson,
    renderServiceWorkerJs:       renderServiceWorkerJs,
    listVersions:                listVersions,
    archiveVersion:              archiveVersion,
    validateIcons:               function (icons) { return _validateIcons(icons); },
  };
}

module.exports = {
  create:                 create,
  ALLOWED_DISPLAYS:       ALLOWED_DISPLAYS,
  ALLOWED_ORIENTATIONS:   ALLOWED_ORIENTATIONS,
  ALLOWED_DIRS:           ALLOWED_DIRS,
  ALLOWED_STRATEGIES:     ALLOWED_STRATEGIES,
  ALLOWED_ICON_PURPOSES:  ALLOWED_ICON_PURPOSES,
  ALLOWED_SCOPES:         ALLOWED_SCOPES,
  MAX_NAME_LEN:           MAX_NAME_LEN,
  MAX_SHORT_NAME_LEN:     MAX_SHORT_NAME_LEN,
  MAX_DESCRIPTION_LEN:    MAX_DESCRIPTION_LEN,
  MAX_URL_LEN:            MAX_URL_LEN,
  MAX_ICON_COUNT:         MAX_ICON_COUNT,
  MAX_PRECACHE_URLS:      MAX_PRECACHE_URLS,
  MAX_RUNTIME_RULES:      MAX_RUNTIME_RULES,
  MAX_LIST_LIMIT:         MAX_LIST_LIMIT,
};
