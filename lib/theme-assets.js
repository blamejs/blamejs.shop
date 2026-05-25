"use strict";
/**
 * @module shop.themeAssets
 * @title  Theme assets — operator-uploaded artifacts referenced by themes
 *
 * @intro
 *   Operators upload theme artifacts (fonts, logo variants, hero
 *   images, favicons, banner / og / icon images, plus a `custom`
 *   escape hatch) and assign them to a theme. The render-time picker
 *   dispatches off the `kind` enum and the `theme_slug` assignment:
 *   the active theme's header asks for `kind=logo`, the storefront
 *   resolves the single logo assigned to the active theme.
 *
 *   Distinct from the `theme` primitive — that one manages the active
 *   theme slug + template directory. This is the asset catalog +
 *   content-addressed storage references.
 *
 *   Each asset carries:
 *     - a stable URL-friendly `slug` (PK),
 *     - a `kind` token from a closed enum (font / logo / hero_image /
 *       favicon / banner_image / og_image / icon / custom),
 *     - an IANA `content_type` (e.g. `font/woff2`, `image/svg+xml`),
 *     - a `sha3_512` digest of the asset bytes — validated as a
 *       128-char lowercase hex shape at the app layer; backs the
 *       upload de-dupe lookup,
 *     - a non-negative `byte_size`,
 *     - a `source_url` — https-only or /-rooted internal path,
 *       validated through `b.safeUrl` at write time,
 *     - optional `alt_text` for image kinds,
 *     - optional `theme_slug` — NULL while the asset sits in the
 *       library; set by `assignToTheme` when the operator wires it
 *       into a theme,
 *     - `archived_at` — soft delete; archived assets stay in the
 *       table so a clone or audit can resolve the slug but drop out
 *       of `assetsForTheme` / `assetsByKind`,
 *     - `impression_count` — denormalized counter the hot-path
 *       `recordImpression` bumps; `metricsForAsset` reads it in
 *       addition to scanning the impression-event log.
 *
 *   Composes:
 *     - `b.safeUrl.parse` — `source_url` is HTTPS-only at the app
 *       layer (or a /-rooted absolute path for storefront-internal
 *       routes). javascript: / data: / vbscript: refused before the
 *       row is persisted.
 *     - Per-factory monotonic clock — guarantees `created_at` /
 *       `updated_at` / `occurred_at` are strictly increasing so a
 *       tied `created_at` still sorts deterministically when two
 *       writes land in the same millisecond.
 *
 *   Surface:
 *     - `create({ query? })` — factory. `query` is optional; absent
 *       it, the primitive talks to `b.externalDb.query` directly.
 *     - `registerAsset({ slug, kind, content_type, sha3_512,
 *                       byte_size, source_url, alt_text?,
 *                       theme_slug? })` — insert an asset row.
 *     - `getAsset(slug)` — single row, any archive state.
 *     - `assetsForTheme(theme_slug)` — enumerate active assets
 *       assigned to a given theme.
 *     - `assetsByKind({ kind, theme_slug? })` — enumerate active
 *       assets by kind. `theme_slug` filter is optional; when
 *       omitted, returns every active asset of that kind regardless
 *       of theme assignment (the asset library scan).
 *     - `updateAsset(slug, patch)` — patch any of `content_type /
 *       source_url / alt_text / byte_size / sha3_512`.
 *     - `archiveAsset(slug)` — stamp `archived_at`. Idempotent-
 *       refusal on re-archive.
 *     - `assignToTheme({ slug, theme_slug })` — swap an asset's
 *       theme assignment. Pass `theme_slug: null` to detach.
 *     - `recordImpression(slug)` — drop-silent hot-path counter
 *       bump on the storefront render that resolves the asset.
 *     - `metricsForAsset({ slug, from, to })` — windowed impression
 *       count + lifetime denormalized count.
 *     - `cleanupOrphans({ days_idle })` — archive every active asset
 *       with `theme_slug IS NULL` whose `updated_at` is older than
 *       `now - days_idle * 86400000`. Returns the count of archived
 *       rows.
 *
 *   Storage:
 *     - `theme_assets` + `theme_asset_impressions`
 *       (migration `0131_theme_assets.sql`).
 *
 * @primitive themeAssets
 * @related   b.safeUrl, b.uuid.v7
 */

var b = require("./index").framework;

var MAX_SLUG_LEN         = 80;
var MAX_THEME_SLUG_LEN   = 80;
var MAX_CONTENT_TYPE_LEN = 128;
var MAX_SOURCE_URL_LEN   = 2048;
var MAX_ALT_TEXT_LEN     = 500;
var SHA3_512_HEX_LEN     = 128;

var ALLOWED_KINDS = Object.freeze([
  "font",
  "logo",
  "hero_image",
  "favicon",
  "banner_image",
  "og_image",
  "icon",
  "custom",
]);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "content_type",
  "source_url",
  "alt_text",
  "byte_size",
  "sha3_512",
]);

// Slug shape mirrors the rest of the storefront primitives — alnum
// leading character, alnum + dot + hyphen + underscore tail, capped
// length. Reaches operator logs + admin URLs.
var SLUG_RE       = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
var THEME_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// Lowercase hex, exactly 128 chars for a SHA3-512 digest. The
// content-addressed lookup is byte-exact, so the canonical form is
// lowercase — uppercase / mixed-case inputs refused so the upload
// pipeline doesn't end up with two index entries for the same bytes.
var SHA3_512_HEX_RE = /^[0-9a-f]{128}$/;

// IANA media type shape — `type/subtype` with the standard token
// alphabet on each side, optional `; param=value` suffix. The intent
// isn't full RFC 7231 conformance — it's "refuse obvious junk before
// the storefront tries to set a Content-Type header from it".
var CONTENT_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+\s*=\s*(?:"[^"\x00-\x1f]*"|[A-Za-z0-9!#$&^_.+-]+))*$/;

// Refuse C0 control bytes + DEL in operator-authored text fields.
var CONTROL_BYTE_LINE_RE = /[\x00-\x1f\x7f]/;

// Zero-width / direction-override family — mirrors the rest of the
// shop primitives. Spelled with \u-escapes so ESLint's
// no-irregular-whitespace stays happy.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var MS_PER_DAY = b.constants.TIME.days(1);

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  label = label || "slug";
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError(
      "themeAssets: " + label +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)"
    );
  }
  return s;
}

function _themeSlug(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !THEME_SLUG_RE.test(s)) {
    throw new TypeError(
      "themeAssets: theme_slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ " +
      "(<= " + MAX_THEME_SLUG_LEN + " chars) or be null"
    );
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || ALLOWED_KINDS.indexOf(s) === -1) {
    throw new TypeError(
      "themeAssets: kind must be one of " + JSON.stringify(ALLOWED_KINDS)
    );
  }
  return s;
}

function _contentType(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_CONTENT_TYPE_LEN) {
    throw new TypeError(
      "themeAssets: content_type must be a non-empty IANA media type <= " +
      MAX_CONTENT_TYPE_LEN + " chars"
    );
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("themeAssets: content_type contains control bytes");
  }
  if (!CONTENT_TYPE_RE.test(s)) {
    throw new TypeError(
      "themeAssets: content_type " + JSON.stringify(s) +
      " is not a valid `type/subtype` shape"
    );
  }
  return s;
}

function _sha3_512(s) {
  if (typeof s !== "string" || s.length !== SHA3_512_HEX_LEN) {
    throw new TypeError(
      "themeAssets: sha3_512 must be a " + SHA3_512_HEX_LEN +
      "-char lowercase hex string"
    );
  }
  if (!SHA3_512_HEX_RE.test(s)) {
    throw new TypeError(
      "themeAssets: sha3_512 must be lowercase hex (0-9a-f), 128 chars"
    );
  }
  return s;
}

function _byteSize(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new TypeError(
      "themeAssets: byte_size must be a non-negative integer"
    );
  }
  return n;
}

// `source_url` — HTTPS-only via `b.safeUrl.parse` OR a /-rooted
// absolute path for storefront-internal routes. Protocol-relative
// `//host/...` URLs are refused — the operator must commit to https
// explicitly so a CDN mis-config can't downgrade the asset link.
// javascript: / data: / vbscript: are refused by safeUrl's default
// protocol allowlist.
function _sourceUrl(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_SOURCE_URL_LEN) {
    throw new TypeError(
      "themeAssets: source_url must be a non-empty string <= " +
      MAX_SOURCE_URL_LEN + " chars"
    );
  }
  if (CONTROL_BYTE_LINE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("themeAssets: source_url contains control / zero-width bytes");
  }
  if (s.charCodeAt(0) === 47 /* "/" */) {
    if (s.length > 1 && s.charCodeAt(1) === 47) {
      throw new TypeError(
        "themeAssets: source_url protocol-relative `//host/...` refused — " +
        "use absolute https:// or a /-rooted absolute path"
      );
    }
    if (s.indexOf("..") !== -1) {
      throw new TypeError("themeAssets: source_url path must not contain '..'");
    }
    return s;
  }
  try {
    b.safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError(
      "themeAssets: source_url — " +
      (e && e.message || "must be https:// or a /-rooted absolute path")
    );
  }
  return s;
}

function _altText(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_ALT_TEXT_LEN) {
    throw new TypeError(
      "themeAssets: alt_text must be a non-empty string <= " +
      MAX_ALT_TEXT_LEN + " chars (or null)"
    );
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("themeAssets: alt_text contains control bytes (incl. CR/LF)");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("themeAssets: alt_text contains zero-width / direction-override characters");
  }
  return s;
}

function _epochMs(n, label) {
  if (typeof n !== "number" || !isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new TypeError(
      "themeAssets: " + label + " must be a non-negative integer epoch-ms"
    );
  }
  return n;
}

function _window(from, to) {
  _epochMs(from, "from");
  _epochMs(to,   "to");
  if (to <= from) {
    throw new TypeError(
      "themeAssets: to (" + to + ") must be > from (" + from + ")"
    );
  }
  return { from: from, to: to };
}

// Per-factory monotonic clock — guarantees `created_at` /
// `updated_at` / `occurred_at` are strictly increasing so a tied
// `created_at` still sorts deterministically when two writes land in
// the same millisecond. Mirrors the shape used by cookie-consent /
// discount-analytics / sms-dispatcher / etc.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- row hydration ------------------------------------------------------

function _hydrateRow(r) {
  if (!r) return null;
  return {
    slug:              r.slug,
    kind:              r.kind,
    content_type:      r.content_type,
    sha3_512:          r.sha3_512,
    byte_size:         Number(r.byte_size),
    source_url:        r.source_url,
    alt_text:          r.alt_text == null ? null : r.alt_text,
    theme_slug:        r.theme_slug == null ? null : r.theme_slug,
    archived_at:       r.archived_at == null ? null : Number(r.archived_at),
    impression_count:  Number(r.impression_count),
    created_at:        Number(r.created_at),
    updated_at:        Number(r.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // -- registerAsset ----------------------------------------------------

  async function registerAsset(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("themeAssets.registerAsset: input object required");
    }
    var slug         = _slug(input.slug);
    var kind         = _kind(input.kind);
    var contentType  = _contentType(input.content_type);
    var sha3         = _sha3_512(input.sha3_512);
    var byteSize     = _byteSize(input.byte_size);
    var sourceUrl    = _sourceUrl(input.source_url);
    var altText      = _altText(input.alt_text);
    var themeSlug    = _themeSlug(input.theme_slug);

    var ts = _now();
    try {
      await query(
        "INSERT INTO theme_assets " +
        "(slug, kind, content_type, sha3_512, byte_size, source_url, " +
        " alt_text, theme_slug, archived_at, impression_count, " +
        " created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, 0, ?9, ?9)",
        [slug, kind, contentType, sha3, byteSize, sourceUrl,
         altText, themeSlug, ts],
      );
    } catch (e) {
      var msg = (e && e.message || "").toLowerCase();
      if (msg.indexOf("unique") !== -1 || msg.indexOf("primary key") !== -1) {
        throw new TypeError(
          "themeAssets.registerAsset: slug " + JSON.stringify(slug) +
          " already exists"
        );
      }
      throw e;
    }
    return await getAsset(slug);
  }

  // -- getAsset ---------------------------------------------------------

  async function getAsset(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM theme_assets WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  // -- assetsForTheme ---------------------------------------------------

  async function assetsForTheme(themeSlug) {
    if (typeof themeSlug !== "string" || !THEME_SLUG_RE.test(themeSlug)) {
      throw new TypeError(
        "themeAssets.assetsForTheme: theme_slug must match " +
        "/^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_THEME_SLUG_LEN + " chars)"
      );
    }
    var rows = (await query(
      "SELECT * FROM theme_assets " +
      " WHERE theme_slug = ?1 AND archived_at IS NULL " +
      " ORDER BY kind ASC, created_at ASC, slug ASC",
      [themeSlug],
    )).rows;
    return rows.map(_hydrateRow);
  }

  // -- assetsByKind -----------------------------------------------------

  async function assetsByKind(listOpts) {
    if (!listOpts || typeof listOpts !== "object") {
      throw new TypeError("themeAssets.assetsByKind: input object required");
    }
    var kind = _kind(listOpts.kind);
    var hasTheme = listOpts.theme_slug !== undefined;
    var themeSlug = hasTheme ? _themeSlug(listOpts.theme_slug) : undefined;

    var sql = "SELECT * FROM theme_assets WHERE kind = ?1 AND archived_at IS NULL";
    var params = [kind];
    if (hasTheme) {
      if (themeSlug == null) {
        sql += " AND theme_slug IS NULL";
      } else {
        sql += " AND theme_slug = ?2";
        params.push(themeSlug);
      }
    }
    sql += " ORDER BY created_at ASC, slug ASC";
    var rows = (await query(sql, params)).rows;
    return rows.map(_hydrateRow);
  }

  // -- updateAsset ------------------------------------------------------

  async function updateAsset(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("themeAssets.updateAsset: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError(
        "themeAssets.updateAsset: patch must include at least one column"
      );
    }

    var current = await getAsset(slug);
    if (!current) {
      throw new TypeError(
        "themeAssets.updateAsset: slug " + JSON.stringify(slug) + " not found"
      );
    }
    if (current.archived_at != null) {
      throw new TypeError(
        "themeAssets.updateAsset: slug " + JSON.stringify(slug) +
        " is archived — register a new asset to replace it"
      );
    }

    var sets   = [];
    var params = [];
    var idx    = 1;
    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError(
          "themeAssets.updateAsset: unsupported column " + JSON.stringify(col)
        );
      }
      if (col === "content_type") {
        sets.push("content_type = ?" + idx);
        params.push(_contentType(patch[col]));
      } else if (col === "source_url") {
        sets.push("source_url = ?" + idx);
        params.push(_sourceUrl(patch[col]));
      } else if (col === "alt_text") {
        sets.push("alt_text = ?" + idx);
        params.push(_altText(patch[col]));
      } else if (col === "byte_size") {
        sets.push("byte_size = ?" + idx);
        params.push(_byteSize(patch[col]));
      } else /* sha3_512 */ {
        sets.push("sha3_512 = ?" + idx);
        params.push(_sha3_512(patch[col]));
      }
      idx += 1;
    }
    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;

    params.push(slug);
    var r = await query(
      "UPDATE theme_assets SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError(
        "themeAssets.updateAsset: slug " + JSON.stringify(slug) + " not found"
      );
    }
    return await getAsset(slug);
  }

  // -- archiveAsset -----------------------------------------------------

  async function archiveAsset(slug) {
    _slug(slug);
    var current = await getAsset(slug);
    if (!current) {
      throw new TypeError(
        "themeAssets.archiveAsset: slug " + JSON.stringify(slug) + " not found"
      );
    }
    if (current.archived_at != null) {
      throw new TypeError(
        "themeAssets.archiveAsset: slug " + JSON.stringify(slug) +
        " is already archived"
      );
    }
    var ts = _now();
    var r = await query(
      "UPDATE theme_assets SET archived_at = ?1, updated_at = ?1 " +
      " WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError(
        "themeAssets.archiveAsset: slug " + JSON.stringify(slug) +
        " transition race"
      );
    }
    return await getAsset(slug);
  }

  // -- assignToTheme ----------------------------------------------------
  //
  // Swap an asset's theme assignment. Pass `theme_slug: null` to
  // detach (returning the asset to the library). Refuses to swap an
  // archived asset — the operator has to register a new asset to
  // replace it.

  async function assignToTheme(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("themeAssets.assignToTheme: input object required");
    }
    var slug = _slug(input.slug);
    if (!Object.prototype.hasOwnProperty.call(input, "theme_slug")) {
      throw new TypeError(
        "themeAssets.assignToTheme: theme_slug required (string or null)"
      );
    }
    var themeSlug = _themeSlug(input.theme_slug);

    var current = await getAsset(slug);
    if (!current) {
      throw new TypeError(
        "themeAssets.assignToTheme: slug " + JSON.stringify(slug) + " not found"
      );
    }
    if (current.archived_at != null) {
      throw new TypeError(
        "themeAssets.assignToTheme: slug " + JSON.stringify(slug) +
        " is archived — register a new asset to replace it"
      );
    }
    var ts = _now();
    var r = await query(
      "UPDATE theme_assets SET theme_slug = ?1, updated_at = ?2 " +
      " WHERE slug = ?3 AND archived_at IS NULL",
      [themeSlug, ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError(
        "themeAssets.assignToTheme: slug " + JSON.stringify(slug) +
        " transition race"
      );
    }
    return await getAsset(slug);
  }

  // -- recordImpression -------------------------------------------------
  //
  // Drop-silent on bad slug / missing row / archived row — runs on
  // the hot storefront request path (the asset resolves on every
  // page render that surfaces it). Throwing here would crash the
  // response the counter is observing.

  async function recordImpression(slug) {
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      return { recorded: false };
    }
    try {
      var ts = _now();
      var id = b.uuid.v7();
      var bump = await query(
        "UPDATE theme_assets SET impression_count = impression_count + 1, " +
        "  updated_at = ?1 WHERE slug = ?2 AND archived_at IS NULL",
        [ts, slug],
      );
      if (Number(bump.rowCount || 0) === 0) return { recorded: false };
      await query(
        "INSERT INTO theme_asset_impressions (id, asset_slug, occurred_at) " +
        " VALUES (?1, ?2, ?3)",
        [id, slug, ts],
      );
      return { recorded: true, id: id };
    } catch (_e) {
      return { recorded: false };
    }
  }

  // -- metricsForAsset --------------------------------------------------

  async function metricsForAsset(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("themeAssets.metricsForAsset: input object required");
    }
    var slug   = _slug(input.slug);
    var window = _window(input.from, input.to);

    var asset = await getAsset(slug);
    if (!asset) {
      throw new TypeError(
        "themeAssets.metricsForAsset: slug " + JSON.stringify(slug) + " not found"
      );
    }
    var row = (await query(
      "SELECT COUNT(*) AS impressions " +
      "  FROM theme_asset_impressions " +
      " WHERE asset_slug = ?1 AND occurred_at >= ?2 AND occurred_at < ?3",
      [slug, window.from, window.to],
    )).rows[0] || {};
    return {
      slug:                slug,
      from:                window.from,
      to:                  window.to,
      impressions:         Number(row.impressions) || 0,
      lifetime_impressions: asset.impression_count,
    };
  }

  // -- cleanupOrphans ---------------------------------------------------
  //
  // Archive every active asset with `theme_slug IS NULL` whose
  // `updated_at` is older than `now - days_idle * 86400000`. Returns
  // the count of archived rows. The intent is the "asset library
  // hygiene" path: assets the operator uploaded but never assigned
  // to a theme accumulate over time; this primitive batch-archives
  // the stale ones without touching anything that's currently in
  // use.

  async function cleanupOrphans(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("themeAssets.cleanupOrphans: input object required");
    }
    var days = input.days_idle;
    if (typeof days !== "number" || !isFinite(days) || days < 0 || Math.floor(days) !== days) {
      throw new TypeError(
        "themeAssets.cleanupOrphans: days_idle must be a non-negative integer"
      );
    }
    var ts     = _now();
    var cutoff = ts - days * MS_PER_DAY;
    var r = await query(
      "UPDATE theme_assets SET archived_at = ?1, updated_at = ?1 " +
      " WHERE archived_at IS NULL " +
      "   AND theme_slug IS NULL " +
      "   AND updated_at < ?2",
      [ts, cutoff],
    );
    return { archived: Number(r.rowCount || 0) };
  }

  return {
    MAX_SLUG_LEN:          MAX_SLUG_LEN,
    MAX_THEME_SLUG_LEN:    MAX_THEME_SLUG_LEN,
    MAX_CONTENT_TYPE_LEN:  MAX_CONTENT_TYPE_LEN,
    MAX_SOURCE_URL_LEN:    MAX_SOURCE_URL_LEN,
    MAX_ALT_TEXT_LEN:      MAX_ALT_TEXT_LEN,
    SHA3_512_HEX_LEN:      SHA3_512_HEX_LEN,
    ALLOWED_KINDS:         ALLOWED_KINDS,
    ALLOWED_PATCH_COLUMNS: ALLOWED_PATCH_COLUMNS,

    registerAsset:    registerAsset,
    getAsset:         getAsset,
    assetsForTheme:   assetsForTheme,
    assetsByKind:     assetsByKind,
    updateAsset:      updateAsset,
    archiveAsset:     archiveAsset,
    assignToTheme:    assignToTheme,
    recordImpression: recordImpression,
    metricsForAsset:  metricsForAsset,
    cleanupOrphans:   cleanupOrphans,
  };
}

module.exports = {
  create:                create,
  MAX_SLUG_LEN:          MAX_SLUG_LEN,
  MAX_THEME_SLUG_LEN:    MAX_THEME_SLUG_LEN,
  MAX_CONTENT_TYPE_LEN:  MAX_CONTENT_TYPE_LEN,
  MAX_SOURCE_URL_LEN:    MAX_SOURCE_URL_LEN,
  MAX_ALT_TEXT_LEN:      MAX_ALT_TEXT_LEN,
  SHA3_512_HEX_LEN:      SHA3_512_HEX_LEN,
  ALLOWED_KINDS:         ALLOWED_KINDS,
  ALLOWED_PATCH_COLUMNS: ALLOWED_PATCH_COLUMNS,
};
