"use strict";
/**
 * @module shop.trustBadges
 * @title  Trust badges — operator-curated trust signals across the storefront
 *
 * @intro
 *   Operator-authored trust + certification badges that render at six
 *   fixed placements across the storefront:
 *
 *     header               — site-wide trust strip in the masthead.
 *     footer               — trust band above the footer links.
 *     pdp                  — product-detail page trust column.
 *     cart_review          — between cart line items and totals.
 *     checkout             — payment-step reassurance band.
 *     order_confirmation   — post-purchase "thank you" page.
 *
 *   Each badge carries EITHER an inline SVG payload (sanitized through
 *   a strict whitelist that allows only `<svg>`, `<path>`, `<circle>`,
 *   `<rect>`, `<g>`, `<title>`, `<desc>` — every event-handler /
 *   `<script>` / `<foreignObject>` / animation element is refused at
 *   define time) OR a remote https:// image URL. Both is refused.
 *   `link_url` is optional and, when present, passes `b.safeUrl.parse`
 *   against the https-only allowlist (or a /-rooted storefront-internal
 *   path). `placements_json` is the set of placements the badge
 *   surfaces at; a badge can ride multiple placements simultaneously.
 *
 *   Distinct from `promoBanners` (marketing) — trust badges are the
 *   reassurance layer, not the promotion layer. The two primitives
 *   share the storefront placement vocabulary in spirit but each
 *   carries its own placement enum because the placement positions
 *   themselves don't overlap (a trust-signal "header" strip is not
 *   the same surface as a "top_strip" promo announcement).
 *
 *   Composes:
 *     - `b.guardSvg.sanitize` — `svg_payload` reaches the database
 *       sanitized through the strict element + attribute allowlist.
 *       `<script>` / `<foreignObject>` / animation tags / event-
 *       handler attributes / dangerous URL schemes inside the SVG are
 *       stripped before persistence; the raw operator input also
 *       passes through `validate` so any critical issue (DOCTYPE /
 *       SVGZ / bidi) refuses at define time rather than silently
 *       stripping operator intent.
 *     - `b.safeUrl.parse` — `link_url` and `image_url` reach the
 *       persisted row only after the https-only / /-rooted gate.
 *       javascript: / data: / vbscript: refused.
 *     - `b.template.escapeHtml` — `renderHtml` escapes the title /
 *       alt_text / placement / slug attributes so a hostile operator
 *       string lands as inert text.
 *     - `b.crypto.namespaceHash` + `b.uuid.v7` — `recordImpression` /
 *       `recordClick` hash the optional session_id under a primitive-
 *       local namespace so the event log can answer "how many unique
 *       sessions saw badge X" without storing raw session identifiers.
 *
 *   Surface:
 *     - `defineBadge({ slug, title, svg_payload_or_image_url,
 *                      link_url?, placements: [...], starts_at?,
 *                      expires_at?, alt_text, priority })` — input
 *       accepts EITHER `svg_payload` OR `image_url` (the spec name
 *       `svg_payload_or_image_url` is destructured into the two
 *       columns; supplying both refuses).
 *     - `getBadge(slug)` / `listBadges({ active_only? })` /
 *       `updateBadge(slug, patch)` / `archiveBadge(slug)`.
 *     - `activeForPlacement({ placement, now? })` — priority-sorted
 *       list of active (non-archived, in-window, placement-matching)
 *       badges. A placement can stack multiple badges simultaneously,
 *       so the API returns an array, not a single winner (contrast
 *       with `promoBanners.activeForPlacement` which picks one).
 *     - `renderHtml({ slug })` — sanitized HTML string ready for
 *       inline insertion into a storefront template.
 *     - `recordImpression({ slug, placement, session_id? })` /
 *       `recordClick({ slug, placement, session_id? })` — drop-silent
 *       on unknown slug / bad-shape input (these run on the hot
 *       request path; throwing here would crash the storefront page
 *       that triggered the event).
 *
 *   Storage:
 *     - `trust_badges` + `trust_badge_events`
 *       (migration `0111_trust_badges.sql`).
 *
 * @primitive trustBadges
 * @related   b.guardSvg, b.safeUrl, b.template.escapeHtml, b.crypto.namespaceHash
 */

var MAX_SLUG_LEN          = 80;
var MAX_TITLE_LEN         = 200;
var MAX_ALT_TEXT_LEN      = 300;
var MAX_LINK_URL_LEN      = 2048;
var MAX_IMAGE_URL_LEN     = 2048;
var MAX_SVG_PAYLOAD_BYTES = 65536;
var MAX_PLACEMENTS        = 6;

var ALLOWED_PLACEMENTS = Object.freeze([
  "header",
  "footer",
  "pdp",
  "cart_review",
  "checkout",
  "order_confirmation",
]);

// The strict element allowlist this primitive enforces. We constrain
// `b.guardSvg.sanitize` to this exact set so even the strict guard
// profile's default (`text` / `tspan` / `metadata` / `defs`) is
// further narrowed to the trust-badge palette.
var ALLOWED_SVG_TAGS = Object.freeze([
  "svg", "path", "circle", "rect", "g", "title", "desc",
]);

// Event-type vocabulary for `trust_badge_events`. Mirrors the
// schema CHECK so a drift between the JS enum and the SQL CHECK is
// caught immediately by either the test suite or the constraint.
var EVENT_TYPES = Object.freeze(["impression", "click"]);

// Slug shape — alnum + hyphen + dot + underscore, leading char alnum,
// capped length. Same shape promoBanners + autoDiscount use.
var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// Refuse C0 control bytes + DEL in single-line operator strings.

// Zero-width / direction-override family — same catalogue as the
// other operator-authored primitives.

// Hash namespace — opaque per-primitive constant so a session_id_hash
// emitted by trustBadges can't collide with one emitted by analytics
// or affiliates for the same underlying session_id.
var SESSION_NAMESPACE = "trust-badges-session";

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "svg_payload",
  "image_url",
  "link_url",
  "placements",
  "starts_at",
  "expires_at",
  "alt_text",
  "priority",
]);

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  label = label || "slug";
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("trustBadges: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _placement(s) {
  if (typeof s !== "string" || ALLOWED_PLACEMENTS.indexOf(s) === -1) {
    throw new TypeError("trustBadges: placement must be one of " + JSON.stringify(ALLOWED_PLACEMENTS));
  }
  return s;
}

function _placements(arr) {
  if (!Array.isArray(arr) || !arr.length) {
    throw new TypeError("trustBadges: placements must be a non-empty array");
  }
  if (arr.length > MAX_PLACEMENTS) {
    throw new TypeError("trustBadges: placements must have ≤ " + MAX_PLACEMENTS + " entries");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var p = _placement(arr[i]);
    if (seen[p]) {
      throw new TypeError("trustBadges: placements contains duplicate " + JSON.stringify(p));
    }
    seen[p] = true;
    out.push(p);
  }
  return out;
}

function _line(s, label, maxLen) {
  if (typeof s !== "string" || !s.length || s.length > maxLen) {
    throw new TypeError("trustBadges: " + label + " must be a non-empty string ≤ " + maxLen + " chars");
  }
  if (textGuard.hasCodepointThreat(s, { singleLine: "reject" })) {
    throw new TypeError("trustBadges: " + label + " contains control bytes (incl. CR/LF)");
  }
  if (textGuard.hasCodepointThreat(s, { zeroWidth: "reject" })) {
    throw new TypeError("trustBadges: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

// Link / image URL discipline — same envelope as promoBanners: either
// https:// (gated by safeUrl) or a /-rooted absolute path.
// Protocol-relative `//host/...` refused so a CDN mis-config can't
// downgrade the link.
function _httpsOrRootUrl(s, label, maxLen) {
  if (typeof s !== "string" || !s.length || s.length > maxLen) {
    throw new TypeError("trustBadges: " + label + " must be a non-empty string ≤ " + maxLen + " chars");
  }
  if (textGuard.hasCodepointThreat(s, { singleLine: "reject", zeroWidth: "reject" })) {
    throw new TypeError("trustBadges: " + label + " contains control / zero-width bytes");
  }
  if (s.charCodeAt(0) === 47 /* "/" */) {
    if (s.length > 1 && s.charCodeAt(1) === 47) {
      throw new TypeError("trustBadges: " + label + " protocol-relative `//host/...` refused — use absolute https://");
    }
    if (s.indexOf("..") !== -1) {
      throw new TypeError("trustBadges: " + label + " path must not contain '..'");
    }
    return s;
  }
  try {
    b.safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("trustBadges: " + label + " — " + (e && e.message || "must be https:// or a /-rooted absolute path"));
  }
  return s;
}

function _linkUrl(s) {
  if (s == null) return null;
  return _httpsOrRootUrl(s, "link_url", MAX_LINK_URL_LEN);
}

function _imageUrl(s) {
  if (s == null) return null;
  return _httpsOrRootUrl(s, "image_url", MAX_IMAGE_URL_LEN);
}

// SVG payload — passes through `b.guardSvg` twice:
//
//   1. `validate` first against the strict profile constrained to the
//      trust-badge tag whitelist. If any critical / high-severity
//      issue is reported (DOCTYPE, SVGZ, bidi when policy=reject,
//      tag-not-in-allowlist, dangerous URL scheme inside the SVG), we
//      refuse the operator input at define time rather than silently
//      stripping their intent.
//
//   2. `sanitize` produces the bytes that actually land in the
//      database — even after validate passes, the sanitizer normalises
//      attribute casing and drops any audit-level concerns (residual
//      bidi codepoints stripped, etc.) so reads pass straight through
//      to the storefront without re-sanitization.
function _svgPayload(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("trustBadges: svg_payload must be a non-empty string when supplied");
  }
  if (Buffer.byteLength(s, "utf8") > MAX_SVG_PAYLOAD_BYTES) {
    throw new TypeError("trustBadges: svg_payload exceeds " + MAX_SVG_PAYLOAD_BYTES + " bytes");
  }
  var guard = b.guardSvg;
  var rv = guard.validate(s, {
    profile:     "strict",
    allowedTags: ALLOWED_SVG_TAGS,
  });
  if (!rv.ok) {
    // Surface the first critical/high issue so the operator gets a
    // diagnosable error rather than a generic refusal. The guard
    // catalogue emits `kind` strings like "svg.dangerous-tag" /
    // "svg.dangerous-scheme" / "svg.svgz" / "svg.doctype" — pass
    // through the kind so the operator can fix the input precisely.
    var critical = null;
    for (var i = 0; i < rv.issues.length; i += 1) {
      if (rv.issues[i].severity === "critical" || rv.issues[i].severity === "high") {
        critical = rv.issues[i];
        break;
      }
    }
    var kind = critical ? critical.kind : (rv.issues[0] && rv.issues[0].kind) || "unknown";
    throw new TypeError("trustBadges: svg_payload refused by guardSvg (" + kind + ")");
  }
  // Sanitize to canonical form. The sanitizer can throw on SVGZ
  // input; validate would already have caught that, but the
  // try/wrap keeps the error shape consistent for any future
  // guardSvg evolution that surfaces a new sanitize-throw class.
  try {
    return guard.sanitize(s, {
      profile:     "strict",
      allowedTags: ALLOWED_SVG_TAGS,
    });
  } catch (e) {
    throw new TypeError("trustBadges: svg_payload — " + (e && e.message || "guardSvg.sanitize threw"));
  }
}

function _priority(n) {
  if (n == null) return 0;
  if (!Number.isInteger(n) || n < 0 || n > 1000000) {
    throw new TypeError("trustBadges: priority must be an integer in [0, 1000000]");
  }
  return n;
}

function _epochMsOptional(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("trustBadges: " + label + " must be a non-negative integer (epoch ms) or null");
  }
  return n;
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

function _hydrateRow(r) {
  if (!r) return null;
  var placements;
  try { placements = JSON.parse(r.placements_json); }
  catch (_e) { placements = []; }
  return {
    slug:              r.slug,
    title:             r.title,
    svg_payload:       r.svg_payload,
    image_url:         r.image_url,
    link_url:          r.link_url,
    placements:        placements,
    starts_at:         r.starts_at == null ? null : Number(r.starts_at),
    expires_at:        r.expires_at == null ? null : Number(r.expires_at),
    alt_text:          r.alt_text,
    priority:          Number(r.priority),
    archived_at:       r.archived_at == null ? null : Number(r.archived_at),
    impression_count:  Number(r.impression_count),
    click_count:       Number(r.click_count),
    created_at:        Number(r.created_at),
    updated_at:        Number(r.updated_at),
  };
}

function _inWindow(badge, nowTs) {
  if (badge.starts_at != null && nowTs < badge.starts_at) return false;
  if (badge.expires_at != null && nowTs >= badge.expires_at) return false;
  return true;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // -- defineBadge -------------------------------------------------------

  async function defineBadge(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("trustBadges.defineBadge: input object required");
    }
    var slug       = _slug(input.slug);
    var title      = _line(input.title, "title", MAX_TITLE_LEN);

    var hasSvg   = input.svg_payload != null;
    var hasImage = input.image_url   != null;
    if (hasSvg && hasImage) {
      throw new TypeError("trustBadges.defineBadge: supply either svg_payload OR image_url, not both");
    }
    if (!hasSvg && !hasImage) {
      throw new TypeError("trustBadges.defineBadge: one of svg_payload / image_url is required");
    }
    var svgPayload = hasSvg   ? _svgPayload(input.svg_payload) : null;
    var imageUrl   = hasImage ? _imageUrl(input.image_url)     : null;

    var linkUrl    = _linkUrl(input.link_url);
    var placements = _placements(input.placements);
    var altText    = _line(input.alt_text, "alt_text", MAX_ALT_TEXT_LEN);
    var priority   = _priority(input.priority);
    var startsAt   = _epochMsOptional(input.starts_at,  "starts_at");
    var expiresAt  = _epochMsOptional(input.expires_at, "expires_at");
    if (startsAt != null && expiresAt != null && expiresAt <= startsAt) {
      throw new TypeError("trustBadges.defineBadge: expires_at must be strictly greater than starts_at");
    }

    var ts = _now();
    await query(
      "INSERT INTO trust_badges (slug, title, svg_payload, image_url, link_url, placements_json, " +
      "starts_at, expires_at, alt_text, priority, archived_at, impression_count, click_count, " +
      "created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, 0, 0, ?11, ?11)",
      [slug, title, svgPayload, imageUrl, linkUrl, JSON.stringify(placements),
       startsAt, expiresAt, altText, priority, ts],
    );
    return await getBadge(slug);
  }

  // -- listBadges / getBadge --------------------------------------------

  async function listBadges(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      if (typeof listOpts.active_only !== "boolean") {
        throw new TypeError("trustBadges.listBadges: active_only must be a boolean");
      }
      activeOnly = listOpts.active_only;
    }
    var sql, params;
    if (activeOnly) {
      var nowTs = _now();
      sql = "SELECT * FROM trust_badges WHERE archived_at IS NULL " +
            "AND (starts_at IS NULL OR starts_at <= ?1) " +
            "AND (expires_at IS NULL OR expires_at > ?1) " +
            "ORDER BY priority DESC, created_at ASC, slug ASC";
      params = [nowTs];
    } else {
      sql    = "SELECT * FROM trust_badges ORDER BY created_at ASC, slug ASC";
      params = [];
    }
    var rows = (await query(sql, params)).rows;
    return rows.map(_hydrateRow);
  }

  async function getBadge(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM trust_badges WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  // -- updateBadge ------------------------------------------------------

  async function updateBadge(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("trustBadges.updateBadge: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("trustBadges.updateBadge: patch must include at least one column");
    }
    var current = await getBadge(slug);
    if (!current) {
      throw new TypeError("trustBadges.updateBadge: slug " + JSON.stringify(slug) + " not found");
    }

    var sets   = [];
    var params = [];
    var idx    = 1;
    var postSvgPayload = current.svg_payload;
    var postImageUrl   = current.image_url;
    var postStartsAt   = current.starts_at;
    var postExpiresAt  = current.expires_at;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("trustBadges.updateBadge: unsupported column " + JSON.stringify(col));
      }
      var v;
      if (col === "title")            { v = _line(patch[col], "title", MAX_TITLE_LEN); sets.push("title = ?" + idx); params.push(v); idx += 1; }
      else if (col === "svg_payload") {
        v = patch[col] == null ? null : _svgPayload(patch[col]);
        postSvgPayload = v;
        sets.push("svg_payload = ?" + idx); params.push(v); idx += 1;
      }
      else if (col === "image_url") {
        v = patch[col] == null ? null : _imageUrl(patch[col]);
        postImageUrl = v;
        sets.push("image_url = ?" + idx); params.push(v); idx += 1;
      }
      else if (col === "link_url") {
        v = patch[col] == null ? null : _linkUrl(patch[col]);
        sets.push("link_url = ?" + idx); params.push(v); idx += 1;
      }
      else if (col === "placements") {
        v = _placements(patch[col]);
        sets.push("placements_json = ?" + idx); params.push(JSON.stringify(v)); idx += 1;
      }
      else if (col === "alt_text")  { v = _line(patch[col], "alt_text", MAX_ALT_TEXT_LEN); sets.push("alt_text = ?" + idx); params.push(v); idx += 1; }
      else if (col === "priority")  { v = _priority(patch[col]); sets.push("priority = ?" + idx); params.push(v); idx += 1; }
      else if (col === "starts_at") {
        v = _epochMsOptional(patch[col], "starts_at");
        postStartsAt = v;
        sets.push("starts_at = ?" + idx); params.push(v); idx += 1;
      }
      else /* expires_at */ {
        v = _epochMsOptional(patch[col], "expires_at");
        postExpiresAt = v;
        sets.push("expires_at = ?" + idx); params.push(v); idx += 1;
      }
    }

    // Cross-column invariants: exactly one of svg_payload / image_url
    // is non-NULL on the resulting row; window monotonic when both
    // bounds present.
    if (postSvgPayload != null && postImageUrl != null) {
      throw new TypeError("trustBadges.updateBadge: svg_payload and image_url are mutually exclusive");
    }
    if (postSvgPayload == null && postImageUrl == null) {
      throw new TypeError("trustBadges.updateBadge: one of svg_payload / image_url must remain set");
    }
    if (postStartsAt != null && postExpiresAt != null && postExpiresAt <= postStartsAt) {
      throw new TypeError("trustBadges.updateBadge: expires_at must be strictly greater than starts_at");
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE trust_badges SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("trustBadges.updateBadge: slug " + JSON.stringify(slug) + " not found");
    }
    return await getBadge(slug);
  }

  // -- archiveBadge -----------------------------------------------------

  async function archiveBadge(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE trust_badges SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getBadge(slug);
      if (!existing) {
        throw new TypeError("trustBadges.archiveBadge: slug " + JSON.stringify(slug) + " not found");
      }
      // Already archived — idempotent return.
      return existing;
    }
    return await getBadge(slug);
  }

  // -- activeForPlacement -----------------------------------------------

  async function activeForPlacement(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("trustBadges.activeForPlacement: input object required");
    }
    var placement = _placement(input.placement);
    var nowTs;
    if (input.now == null) {
      nowTs = _now();
    } else {
      if (!Number.isInteger(input.now) || input.now < 0) {
        throw new TypeError("trustBadges.activeForPlacement: now must be a non-negative integer (epoch ms) when supplied");
      }
      nowTs = input.now;
    }

    // Read every candidate non-archived in-window row, then filter
    // placement at the JS layer (the small JSON array means a SQL
    // LIKE-on-json would be both fragile and unnecessary; the row
    // count for trust badges stays bounded by operator authoring).
    var rows = (await query(
      "SELECT * FROM trust_badges " +
      "WHERE archived_at IS NULL " +
      "AND (starts_at IS NULL OR starts_at <= ?1) " +
      "AND (expires_at IS NULL OR expires_at > ?1) " +
      "ORDER BY priority DESC, created_at ASC, slug ASC",
      [nowTs],
    )).rows;

    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = _hydrateRow(rows[i]);
      if (row.placements.indexOf(placement) === -1) continue;
      if (!_inWindow(row, nowTs)) continue;
      out.push(row);
    }
    return out;
  }

  // -- renderHtml -------------------------------------------------------

  async function renderHtml(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("trustBadges.renderHtml: input object required");
    }
    var slug = _slug(input.slug);
    var badge = await getBadge(slug);
    if (!badge) {
      throw new TypeError("trustBadges.renderHtml: slug " + JSON.stringify(slug) + " not found");
    }
    var escapeHtml = b.template.escapeHtml;

    var title    = escapeHtml(badge.title);
    var altText  = escapeHtml(badge.alt_text);
    var slugAttr = escapeHtml(badge.slug);

    var parts = [];
    var wrapperOpen;
    if (badge.link_url) {
      wrapperOpen = '<a class="trust-badge" data-trust-badge-slug="' + slugAttr +
                    '" href="' + escapeHtml(badge.link_url) +
                    '" title="' + title + '" rel="noopener">';
      parts.push(wrapperOpen);
    } else {
      parts.push('<span class="trust-badge" data-trust-badge-slug="' + slugAttr +
                 '" title="' + title + '">');
    }
    if (badge.svg_payload) {
      // svg_payload landed in the DB only after the strict sanitizer
      // stripped every script / event-handler / dangerous URL scheme,
      // so emitting it inline is safe. We wrap with role="img" +
      // aria-label="<alt>" so assistive tech announces the trust
      // signal even though the SVG itself doesn't carry an alt attr.
      parts.push('<span class="trust-badge__svg" role="img" aria-label="' + altText + '">');
      parts.push(badge.svg_payload);
      parts.push('</span>');
    } else {
      parts.push('<img class="trust-badge__image" src="' + escapeHtml(badge.image_url) +
                 '" alt="' + altText + '" />');
    }
    parts.push(badge.link_url ? '</a>' : '</span>');
    return parts.join("");
  }

  // -- analytics: impression + click counters ---------------------------

  // Drop-silent on bad slug / missing row / bad placement — these
  // run on the hot request path (impression on every storefront
  // page render that surfaces the badge, click on the redirect
  // handler before the customer reaches the trust-signal
  // destination). Throwing here would crash the response the
  // counter is observing.
  function _normalizeEventInput(input) {
    if (!input || typeof input !== "object") return null;
    var slug = input.slug;
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) return null;
    var placement = input.placement;
    if (typeof placement !== "string" || ALLOWED_PLACEMENTS.indexOf(placement) === -1) return null;
    var sessionId = null;
    if (input.session_id != null) {
      if (typeof input.session_id !== "string" || !input.session_id.length || input.session_id.length > 256) {
        return null;
      }
      sessionId = input.session_id;
    }
    return { slug: slug, placement: placement, session_id: sessionId };
  }

  async function _recordEvent(eventType, input) {
    var n = _normalizeEventInput(input);
    if (!n) return { recorded: false };
    try {
      var sessionHash = n.session_id == null ? null
        : b.crypto.namespaceHash(SESSION_NAMESPACE, n.session_id);
      var ts = _now();
      var id = b.uuid.v7();
      var counterCol = eventType === "impression" ? "impression_count" : "click_count";
      // Two-step write: bump the counter on the badge (only if the
      // badge exists + isn't archived — `WHERE archived_at IS NULL`
      // guards a hot-path counter from incrementing on a stale slug
      // the storefront cached past archive time), then append to the
      // event log when the counter bump landed.
      var bump = await query(
        "UPDATE trust_badges SET " + counterCol + " = " + counterCol + " + 1, " +
        "updated_at = ?1 WHERE slug = ?2 AND archived_at IS NULL",
        [ts, n.slug],
      );
      if (Number(bump.rowCount || 0) === 0) return { recorded: false };
      await query(
        "INSERT INTO trust_badge_events (id, badge_slug, placement, event_type, session_id_hash, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [id, n.slug, n.placement, eventType, sessionHash, ts],
      );
      return { recorded: true, id: id };
    } catch (_e) {
      return { recorded: false };
    }
  }

  function recordImpression(input) { return _recordEvent("impression", input); }
  function recordClick(input)      { return _recordEvent("click",      input); }

  return {
    MAX_SLUG_LEN:          MAX_SLUG_LEN,
    MAX_TITLE_LEN:         MAX_TITLE_LEN,
    MAX_ALT_TEXT_LEN:      MAX_ALT_TEXT_LEN,
    MAX_LINK_URL_LEN:      MAX_LINK_URL_LEN,
    MAX_IMAGE_URL_LEN:     MAX_IMAGE_URL_LEN,
    MAX_SVG_PAYLOAD_BYTES: MAX_SVG_PAYLOAD_BYTES,
    ALLOWED_PLACEMENTS:    ALLOWED_PLACEMENTS,
    ALLOWED_SVG_TAGS:      ALLOWED_SVG_TAGS,
    EVENT_TYPES:           EVENT_TYPES,

    defineBadge:        defineBadge,
    getBadge:           getBadge,
    listBadges:         listBadges,
    updateBadge:        updateBadge,
    archiveBadge:       archiveBadge,
    activeForPlacement: activeForPlacement,
    renderHtml:         renderHtml,
    recordImpression:   recordImpression,
    recordClick:        recordClick,
  };
}

module.exports = {
  create:                create,
  MAX_SLUG_LEN:          MAX_SLUG_LEN,
  MAX_TITLE_LEN:         MAX_TITLE_LEN,
  MAX_ALT_TEXT_LEN:      MAX_ALT_TEXT_LEN,
  MAX_LINK_URL_LEN:      MAX_LINK_URL_LEN,
  MAX_IMAGE_URL_LEN:     MAX_IMAGE_URL_LEN,
  MAX_SVG_PAYLOAD_BYTES: MAX_SVG_PAYLOAD_BYTES,
  ALLOWED_PLACEMENTS:    ALLOWED_PLACEMENTS,
  ALLOWED_SVG_TAGS:      ALLOWED_SVG_TAGS,
  EVENT_TYPES:           EVENT_TYPES,
};
