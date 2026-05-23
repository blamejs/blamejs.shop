"use strict";
/**
 * @module shop.promoBanners
 * @title  Promo banners — operator-controlled marketing across the storefront
 *
 * @intro
 *   Operator-authored marketing banners that render at six fixed
 *   placements across the storefront:
 *
 *     top_strip       — site-wide announcement strip above the nav.
 *     homepage_hero   — large hero block on the homepage.
 *     pdp_side        — narrow sidebar on the product-detail page.
 *     cart_side       — adjacent to the cart-summary panel.
 *     search_empty    — rendered in place of "no results" copy.
 *     footer          — slim band above the footer links.
 *
 *   Each banner carries a schedule window (starts_at / expires_at),
 *   an audience filter (everyone / logged-in / guest / a named
 *   customer segment), a priority (higher wins when multiple banners
 *   overlap), a theme token, and a CTA URL. `activeForPlacement`
 *   resolves the single banner that wins for a given placement +
 *   viewer + customer at a given instant.
 *
 *   Composes:
 *     - `b.safeUrl.parse` — `cta_url` is HTTPS-only at the app
 *       layer (or a /-rooted absolute path so the operator can link
 *       to a storefront-internal route without ceremony). javascript:
 *       and data: URLs are refused before the banner is persisted.
 *     - `b.template.escapeHtml` — `renderHtml` escapes every
 *       operator-input field so a hostile headline / body / label
 *       lands as inert text in the storefront HTML.
 *
 *   Surface:
 *     - `defineBanner({ slug, placement, headline, body?, cta_label,
 *                       cta_url, image_url?, audience, segment_slug?,
 *                       priority, starts_at, expires_at, theme? })`
 *     - `activeForPlacement({ placement, viewer_kind, customer_id?,
 *                             now })` — highest-priority active
 *       banner for the placement, filtered by audience + segment.
 *     - `listAll({ active_only? })` / `getBanner(slug)` /
 *       `updateBanner(slug, patch)` / `archive(slug)` /
 *       `unarchive(slug)`.
 *     - `renderHtml({ banner, locale? })` — sanitized HTML string
 *       ready for inline insertion into a storefront template.
 *     - `impressionCount(slug)` / `clickCount(slug)` — read counters.
 *     - `recordImpression(slug)` / `recordClick(slug)` — increment.
 *       Drop-silent on unknown slug (these run on the hot request
 *       path; throwing here would crash the storefront response that
 *       triggered the counter).
 *
 *   Storage:
 *     - `promo_banners` (migration `0053_promo_banners.sql`).
 *
 * @primitive promoBanners
 * @related   b.safeUrl, b.template.escapeHtml
 */

var MAX_SLUG_LEN       = 80;
var MAX_HEADLINE_LEN   = 200;
var MAX_BODY_LEN       = 1000;
var MAX_CTA_LABEL_LEN  = 80;
var MAX_CTA_URL_LEN    = 2048;
var MAX_IMAGE_URL_LEN  = 2048;
var MAX_SEGMENT_LEN    = 80;

var ALLOWED_PLACEMENTS = Object.freeze([
  "top_strip",
  "homepage_hero",
  "pdp_side",
  "cart_side",
  "search_empty",
  "footer",
]);

var ALLOWED_AUDIENCES = Object.freeze([
  "all",
  "logged_in",
  "guest",
  "segment",
]);

var ALLOWED_THEMES = Object.freeze([
  "info",
  "promo",
  "urgency",
  "success",
]);

var ALLOWED_VIEWER_KINDS = Object.freeze([
  "logged_in",
  "guest",
]);

// Slug shape mirrors the catalog primitive's convention: alnum +
// hyphen + underscore, leading char alnum, capped length. The slug
// reaches operator-facing logs + URLs in the admin dashboard, so the
// shape stays narrow.
var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// Refuse C0 control bytes + DEL in operator-authored strings — these
// render onto an HTML storefront response and (transitively) into
// operator dashboards. Newlines are allowed in `body` (multi-line
// marketing copy is common); `headline` / `cta_label` refuse LF / CR
// so a single-line presentation slot can't be smuggled into.
var CONTROL_BYTE_LINE_RE   = /[\x00-\x1f\x7f]/;
var CONTROL_BYTE_BLOCK_RE  = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// Zero-width / direction-override family — mirrors the gift-options
// + order-notes catalogues. Spelled with \u-escapes so ESLint's
// no-irregular-whitespace stays happy.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "placement",
  "headline",
  "body",
  "cta_label",
  "cta_url",
  "image_url",
  "audience",
  "segment_slug",
  "priority",
  "theme",
  "starts_at",
  "expires_at",
]);

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("promoBanners: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _placement(s) {
  if (typeof s !== "string" || ALLOWED_PLACEMENTS.indexOf(s) === -1) {
    throw new TypeError("promoBanners: placement must be one of " + JSON.stringify(ALLOWED_PLACEMENTS));
  }
  return s;
}

function _audience(s) {
  if (typeof s !== "string" || ALLOWED_AUDIENCES.indexOf(s) === -1) {
    throw new TypeError("promoBanners: audience must be one of " + JSON.stringify(ALLOWED_AUDIENCES));
  }
  return s;
}

function _theme(s) {
  if (s == null) return "info";
  if (typeof s !== "string" || ALLOWED_THEMES.indexOf(s) === -1) {
    throw new TypeError("promoBanners: theme must be one of " + JSON.stringify(ALLOWED_THEMES));
  }
  return s;
}

function _line(s, label, maxLen) {
  if (typeof s !== "string" || !s.length || s.length > maxLen) {
    throw new TypeError("promoBanners: " + label + " must be a non-empty string ≤ " + maxLen + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("promoBanners: " + label + " contains control bytes (incl. CR/LF)");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("promoBanners: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

function _block(s, label, maxLen) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("promoBanners: " + label + " must be a string");
  }
  if (s.length > maxLen) {
    throw new TypeError("promoBanners: " + label + " must be ≤ " + maxLen + " chars");
  }
  if (CONTROL_BYTE_BLOCK_RE.test(s)) {
    throw new TypeError("promoBanners: " + label + " contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("promoBanners: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

// Validate a CTA URL through `b.safeUrl.parse` (https-only) OR
// accept a /-rooted absolute path. The CTA URL lands into an <a
// href="..."> on the storefront; javascript: / data: / vbscript: are
// all refused by safeUrl's default protocol allowlist. Protocol-
// relative `//host/...` URLs are refused — the operator must commit
// to https explicitly so a CDN mis-config can't downgrade the link.
function _ctaUrl(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_CTA_URL_LEN) {
    throw new TypeError("promoBanners: cta_url must be a non-empty string ≤ " + MAX_CTA_URL_LEN + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("promoBanners: cta_url contains control / zero-width bytes");
  }
  if (s.charCodeAt(0) === 47 /* "/" */) {
    // /-rooted absolute path — refuse protocol-relative `//host`
    // (the second char being "/" turns the link into an off-site
    // URL on the same scheme, which sidesteps the https-only gate).
    if (s.length > 1 && s.charCodeAt(1) === 47) {
      throw new TypeError("promoBanners: cta_url protocol-relative `//host/...` refused — use absolute https://");
    }
    if (s.indexOf("..") !== -1) {
      throw new TypeError("promoBanners: cta_url path must not contain '..'");
    }
    return s;
  }
  try {
    _b().safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("promoBanners: cta_url — " + (e && e.message || "must be https:// or a /-rooted absolute path"));
  }
  return s;
}

// Image URL discipline mirrors `cta_url` — https-only or /-rooted.
// Optional (banners may carry text only).
function _imageUrl(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_IMAGE_URL_LEN) {
    throw new TypeError("promoBanners: image_url must be a non-empty string ≤ " + MAX_IMAGE_URL_LEN + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("promoBanners: image_url contains control / zero-width bytes");
  }
  if (s.charCodeAt(0) === 47 /* "/" */) {
    if (s.length > 1 && s.charCodeAt(1) === 47) {
      throw new TypeError("promoBanners: image_url protocol-relative `//host/...` refused — use absolute https://");
    }
    if (s.indexOf("..") !== -1) {
      throw new TypeError("promoBanners: image_url path must not contain '..'");
    }
    return s;
  }
  try {
    _b().safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("promoBanners: image_url — " + (e && e.message || "must be https:// or a /-rooted absolute path"));
  }
  return s;
}

function _priority(n) {
  if (!Number.isInteger(n) || n < 0 || n > 1000000) {
    throw new TypeError("promoBanners: priority must be an integer in [0, 1000000]");
  }
  return n;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("promoBanners: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _segmentSlug(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_SEGMENT_LEN) {
    throw new TypeError("promoBanners: segment_slug must be a non-empty string ≤ " + MAX_SEGMENT_LEN + " chars");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("promoBanners: segment_slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/");
  }
  return s;
}

function _viewerKind(s) {
  if (typeof s !== "string" || ALLOWED_VIEWER_KINDS.indexOf(s) === -1) {
    throw new TypeError("promoBanners: viewer_kind must be one of " + JSON.stringify(ALLOWED_VIEWER_KINDS));
  }
  return s;
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

function _hydrateRow(r) {
  if (!r) return null;
  return {
    slug:              r.slug,
    placement:         r.placement,
    headline:          r.headline,
    body:              r.body,
    cta_label:         r.cta_label,
    cta_url:           r.cta_url,
    image_url:         r.image_url,
    audience:          r.audience,
    segment_slug:      r.segment_slug,
    priority:          Number(r.priority),
    theme:             r.theme,
    starts_at:         Number(r.starts_at),
    expires_at:        Number(r.expires_at),
    archived_at:       r.archived_at == null ? null : Number(r.archived_at),
    impression_count:  Number(r.impression_count),
    click_count:       Number(r.click_count),
    created_at:        Number(r.created_at),
    updated_at:        Number(r.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // customerSegments is optional — banners with audience = "segment"
  // require it, but a deployment without segment-targeted banners can
  // run without one. The factory captures the handle and the
  // `activeForPlacement` path enforces the requirement lazily, with
  // a clear error message when a segment-audience banner is reached
  // without a segments handle wired up.
  var customerSegments = opts.customerSegments || null;

  // -- defineBanner ------------------------------------------------------

  async function defineBanner(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("promoBanners.defineBanner: input object required");
    }
    var slug       = _slug(input.slug);
    var placement  = _placement(input.placement);
    var headline   = _line(input.headline, "headline", MAX_HEADLINE_LEN);
    var body       = _block(input.body, "body", MAX_BODY_LEN);
    var ctaLabel   = _line(input.cta_label, "cta_label", MAX_CTA_LABEL_LEN);
    var ctaUrl     = _ctaUrl(input.cta_url);
    var imageUrl   = _imageUrl(input.image_url);
    var audience   = _audience(input.audience);
    var segmentSlug;
    if (audience === "segment") {
      if (input.segment_slug == null) {
        throw new TypeError("promoBanners.defineBanner: audience=\"segment\" requires segment_slug");
      }
      segmentSlug = _segmentSlug(input.segment_slug);
    } else {
      if (input.segment_slug != null) {
        throw new TypeError("promoBanners.defineBanner: segment_slug only valid when audience=\"segment\"");
      }
      segmentSlug = null;
    }
    var priority   = _priority(input.priority);
    var theme      = _theme(input.theme);
    var startsAt   = _epochMs(input.starts_at,  "starts_at");
    var expiresAt  = _epochMs(input.expires_at, "expires_at");
    if (expiresAt <= startsAt) {
      throw new TypeError("promoBanners.defineBanner: expires_at must be strictly greater than starts_at");
    }

    var ts = _now();
    await query(
      "INSERT INTO promo_banners (slug, placement, headline, body, cta_label, cta_url, image_url, " +
      "audience, segment_slug, priority, theme, starts_at, expires_at, archived_at, " +
      "impression_count, click_count, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, 0, 0, ?14, ?14)",
      [slug, placement, headline, body, ctaLabel, ctaUrl, imageUrl,
       audience, segmentSlug, priority, theme, startsAt, expiresAt, ts],
    );
    return await getBanner(slug);
  }

  // -- listAll / getBanner ----------------------------------------------

  async function listAll(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      if (typeof listOpts.active_only !== "boolean") {
        throw new TypeError("promoBanners.listAll: active_only must be a boolean");
      }
      activeOnly = listOpts.active_only;
    }
    var sql, params;
    if (activeOnly) {
      var nowTs = _now();
      sql = "SELECT * FROM promo_banners WHERE archived_at IS NULL AND starts_at <= ?1 AND expires_at > ?1 " +
            "ORDER BY priority DESC, created_at ASC, slug ASC";
      params = [nowTs];
    } else {
      sql    = "SELECT * FROM promo_banners ORDER BY created_at ASC, slug ASC";
      params = [];
    }
    var rows = (await query(sql, params)).rows;
    return rows.map(_hydrateRow);
  }

  async function getBanner(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM promo_banners WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  // -- updateBanner ------------------------------------------------------

  async function updateBanner(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("promoBanners.updateBanner: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("promoBanners.updateBanner: patch must include at least one column");
    }
    // Resolve the existing row first so cross-column invariants
    // (audience ↔ segment_slug, starts_at < expires_at) can be
    // checked against the post-patch state without re-reading mid-
    // UPDATE.
    var current = await getBanner(slug);
    if (!current) {
      throw new TypeError("promoBanners.updateBanner: slug " + JSON.stringify(slug) + " not found");
    }

    var sets   = [];
    var params = [];
    var idx    = 1;
    var postAudience    = current.audience;
    var postSegmentSlug = current.segment_slug;
    var postStartsAt    = current.starts_at;
    var postExpiresAt   = current.expires_at;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("promoBanners.updateBanner: unsupported column " + JSON.stringify(col));
      }
      var v;
      if      (col === "placement")     { v = _placement(patch[col]); }
      else if (col === "headline")      { v = _line(patch[col], "headline", MAX_HEADLINE_LEN); }
      else if (col === "body")          { v = _block(patch[col], "body", MAX_BODY_LEN); }
      else if (col === "cta_label")     { v = _line(patch[col], "cta_label", MAX_CTA_LABEL_LEN); }
      else if (col === "cta_url")       { v = _ctaUrl(patch[col]); }
      else if (col === "image_url")     { v = _imageUrl(patch[col]); }
      else if (col === "audience")      { v = _audience(patch[col]); postAudience = v; }
      else if (col === "segment_slug")  { v = patch[col] == null ? null : _segmentSlug(patch[col]); postSegmentSlug = v; }
      else if (col === "priority")      { v = _priority(patch[col]); }
      else if (col === "theme")         { v = _theme(patch[col]); }
      else if (col === "starts_at")     { v = _epochMs(patch[col], "starts_at"); postStartsAt = v; }
      else /* expires_at */             { v = _epochMs(patch[col], "expires_at"); postExpiresAt = v; }
      sets.push(col + " = ?" + idx);
      params.push(v);
      idx += 1;
    }

    if (postAudience === "segment" && postSegmentSlug == null) {
      throw new TypeError("promoBanners.updateBanner: audience=\"segment\" requires segment_slug");
    }
    if (postAudience !== "segment" && postSegmentSlug != null) {
      throw new TypeError("promoBanners.updateBanner: segment_slug only valid when audience=\"segment\"");
    }
    if (postExpiresAt <= postStartsAt) {
      throw new TypeError("promoBanners.updateBanner: expires_at must be strictly greater than starts_at");
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE promo_banners SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("promoBanners.updateBanner: slug " + JSON.stringify(slug) + " not found");
    }
    return await getBanner(slug);
  }

  // -- archive / unarchive ----------------------------------------------

  async function archive(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE promo_banners SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getBanner(slug);
      if (!existing) {
        throw new TypeError("promoBanners.archive: slug " + JSON.stringify(slug) + " not found");
      }
      // Already archived — return the existing row idempotently so
      // operators running an "archive everything" sweep don't have
      // to special-case banners that a coworker archived first.
      return existing;
    }
    return await getBanner(slug);
  }

  async function unarchive(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE promo_banners SET archived_at = NULL, updated_at = ?1 WHERE slug = ?2 AND archived_at IS NOT NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getBanner(slug);
      if (!existing) {
        throw new TypeError("promoBanners.unarchive: slug " + JSON.stringify(slug) + " not found");
      }
      return existing;
    }
    return await getBanner(slug);
  }

  // -- activeForPlacement ------------------------------------------------

  async function activeForPlacement(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("promoBanners.activeForPlacement: input object required");
    }
    var placement  = _placement(input.placement);
    var viewerKind = _viewerKind(input.viewer_kind);
    var nowTs      = _epochMs(input.now, "now");
    var customerId = null;
    if (input.customer_id != null) {
      if (typeof input.customer_id !== "string" || !input.customer_id.length) {
        throw new TypeError("promoBanners.activeForPlacement: customer_id must be a non-empty string when provided");
      }
      customerId = input.customer_id;
    }
    if (viewerKind === "logged_in" && customerId == null) {
      throw new TypeError("promoBanners.activeForPlacement: viewer_kind=\"logged_in\" requires customer_id");
    }
    if (viewerKind === "guest" && customerId != null) {
      throw new TypeError("promoBanners.activeForPlacement: viewer_kind=\"guest\" must not carry customer_id");
    }

    // Read every candidate row for the placement (active window +
    // not archived), sorted by priority DESC. The audience +
    // segment filter is JS-side because the segment-membership
    // check is an external handle call, not a SQL join.
    var rows = (await query(
      "SELECT * FROM promo_banners " +
      "WHERE placement = ?1 AND archived_at IS NULL AND starts_at <= ?2 AND expires_at > ?2 " +
      "ORDER BY priority DESC, created_at ASC, slug ASC",
      [placement, nowTs],
    )).rows;

    for (var i = 0; i < rows.length; i += 1) {
      var b = _hydrateRow(rows[i]);
      if (b.audience === "all") return b;
      if (b.audience === "logged_in" && viewerKind === "logged_in") return b;
      if (b.audience === "guest"     && viewerKind === "guest")     return b;
      if (b.audience === "segment") {
        if (viewerKind !== "logged_in") continue;
        if (!customerSegments) {
          throw new TypeError("promoBanners.activeForPlacement: banner " + JSON.stringify(b.slug) +
            " has audience=\"segment\" but no customerSegments handle was wired into create()");
        }
        if (typeof customerSegments.isMember !== "function") {
          throw new TypeError("promoBanners.activeForPlacement: customerSegments handle must expose isMember(customer_id, segment_slug)");
        }
        var member = await customerSegments.isMember(customerId, b.segment_slug);
        if (member) return b;
        continue;
      }
    }
    return null;
  }

  // -- renderHtml --------------------------------------------------------

  function renderHtml(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("promoBanners.renderHtml: input object required");
    }
    var banner = input.banner;
    if (!banner || typeof banner !== "object") {
      throw new TypeError("promoBanners.renderHtml: banner object required");
    }
    var locale = input.locale;
    if (locale != null) {
      if (typeof locale !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) {
        throw new TypeError("promoBanners.renderHtml: locale must be a BCP-47-shape string (e.g. 'en-US')");
      }
    }
    var escapeHtml = _b().template.escapeHtml;

    // Theme + placement come from a closed enum; pass them through
    // escapeHtml anyway so any future enum expansion that lands a
    // hyphenated value still renders safely.
    var theme     = escapeHtml(banner.theme || "info");
    var placement = escapeHtml(banner.placement);
    var slug      = escapeHtml(banner.slug);
    var headline  = escapeHtml(banner.headline);
    var ctaLabel  = escapeHtml(banner.cta_label);
    var ctaUrl    = escapeHtml(banner.cta_url);
    var localeAttr = locale ? ' lang="' + escapeHtml(locale) + '"' : "";

    var parts = [];
    parts.push('<div class="promo-banner promo-banner--' + theme + ' promo-banner--' + placement +
               '" data-banner-slug="' + slug + '"' + localeAttr + '>');
    if (banner.image_url) {
      parts.push('<img class="promo-banner__image" src="' + escapeHtml(banner.image_url) + '" alt="" />');
    }
    parts.push('<div class="promo-banner__body">');
    parts.push('<h2 class="promo-banner__headline">' + headline + '</h2>');
    if (banner.body) {
      // Split body on LF so multi-line marketing copy renders as
      // one <p> per line. CRLF is normalized to LF; trailing empty
      // lines drop so the output stays tidy.
      var raw = String(banner.body).replace(/\r\n/g, "\n").split("\n");
      while (raw.length && raw[raw.length - 1] === "") raw.pop();
      for (var i = 0; i < raw.length; i += 1) {
        parts.push('<p class="promo-banner__line">' + escapeHtml(raw[i]) + '</p>');
      }
    }
    parts.push('<a class="promo-banner__cta" href="' + ctaUrl + '" data-banner-slug="' + slug + '">' +
               ctaLabel + '</a>');
    parts.push('</div>');
    parts.push('</div>');
    return parts.join("");
  }

  // -- counters ---------------------------------------------------------

  async function impressionCount(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT impression_count FROM promo_banners WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return r ? Number(r.impression_count) : 0;
  }

  async function clickCount(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT click_count FROM promo_banners WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return r ? Number(r.click_count) : 0;
  }

  // Drop-silent on bad slug / missing row — these run on the hot
  // request path (impression on every storefront page render, click
  // on the redirect handler that fires before the customer reaches
  // the CTA destination). Throwing here would crash the response
  // the counter is observing. The validation layer at defineBanner
  // / updateBanner has already verified that legitimate slugs exist;
  // a request that arrives with a stale slug after the banner was
  // archived simply doesn't increment, which is the correct
  // observability behavior.
  async function recordImpression(slug) {
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) return { recorded: false };
    try {
      var r = await query(
        "UPDATE promo_banners SET impression_count = impression_count + 1, updated_at = ?1 WHERE slug = ?2",
        [_now(), slug],
      );
      return { recorded: Number(r.rowCount || 0) > 0 };
    } catch (_e) {
      return { recorded: false };
    }
  }

  async function recordClick(slug) {
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) return { recorded: false };
    try {
      var r = await query(
        "UPDATE promo_banners SET click_count = click_count + 1, updated_at = ?1 WHERE slug = ?2",
        [_now(), slug],
      );
      return { recorded: Number(r.rowCount || 0) > 0 };
    } catch (_e) {
      return { recorded: false };
    }
  }

  return {
    MAX_SLUG_LEN:       MAX_SLUG_LEN,
    MAX_HEADLINE_LEN:   MAX_HEADLINE_LEN,
    MAX_BODY_LEN:       MAX_BODY_LEN,
    MAX_CTA_LABEL_LEN:  MAX_CTA_LABEL_LEN,
    ALLOWED_PLACEMENTS: ALLOWED_PLACEMENTS,
    ALLOWED_AUDIENCES:  ALLOWED_AUDIENCES,
    ALLOWED_THEMES:     ALLOWED_THEMES,

    defineBanner:        defineBanner,
    activeForPlacement:  activeForPlacement,
    listAll:             listAll,
    getBanner:           getBanner,
    updateBanner:        updateBanner,
    archive:             archive,
    unarchive:           unarchive,
    renderHtml:          renderHtml,
    impressionCount:     impressionCount,
    clickCount:          clickCount,
    recordImpression:    recordImpression,
    recordClick:         recordClick,
  };
}

module.exports = {
  create:             create,
  MAX_SLUG_LEN:       MAX_SLUG_LEN,
  MAX_HEADLINE_LEN:   MAX_HEADLINE_LEN,
  MAX_BODY_LEN:       MAX_BODY_LEN,
  MAX_CTA_LABEL_LEN:  MAX_CTA_LABEL_LEN,
  ALLOWED_PLACEMENTS: ALLOWED_PLACEMENTS,
  ALLOWED_AUDIENCES:  ALLOWED_AUDIENCES,
  ALLOWED_THEMES:     ALLOWED_THEMES,
};
