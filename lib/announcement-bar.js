"use strict";
/**
 * @module shop.announcementBar
 * @title  Announcement bar — operator-controlled storefront top strip
 *
 * @intro
 *   The single thin row of text rendered above the storefront
 *   navigation: "Free shipping on orders over $50", "Holiday sale 30%
 *   off", "Order by Dec 18 for Christmas delivery". One announcement
 *   shows at a time. Operators define announcements with a theme, an
 *   optional CTA link, an optional schedule window, and an audience
 *   filter; the storefront calls `activeAnnouncement({ now,
 *   viewer_kind, customer_id })` once per request to resolve which
 *   announcement (if any) wins for the current viewer.
 *
 *   This is intentionally distinct from `promoBanners` — that
 *   primitive carries placement targeting, images, multi-line body
 *   copy, and impression/click counters. The announcement bar is the
 *   text-only strip with one job: a short, time-bounded operator
 *   message at the very top of the page.
 *
 *   Theme ordering (high-priority first):
 *
 *     urgency  — "Last day for free shipping", "Site maintenance at 9pm"
 *     promo    — "30% off everything this weekend"
 *     info     — "We're hiring", "New collection just landed"
 *     success  — "Thanks for shopping — order confirmation sent"
 *
 *   When multiple announcements are active in the same window,
 *   `activeAnnouncement` picks the highest-priority theme; ties break
 *   on `updated_at DESC` then `slug ASC` (deterministic, no random
 *   tie-break — operators expect the announcement they most recently
 *   edited to win).
 *
 *   Audience filter:
 *
 *     all        — every viewer sees it
 *     logged_in  — only signed-in customers (customer_id required)
 *     guest      — only guests (customer_id must be absent)
 *     segment    — only members of the named segment (requires the
 *                  customerSegments handle wired into create())
 *
 *   Dismissal:
 *
 *     A `dismissible: true` announcement renders with a close button;
 *     the storefront calls `recordDismissal({ slug, session_id })` and
 *     the announcement is filtered out of subsequent
 *     `activeAnnouncement` calls for that session. The raw session id
 *     is hashed at the boundary via `b.crypto.namespaceHash` —
 *     storage carries only the digest, so an operator scanning the
 *     dismissal log never sees the session token.
 *
 *   Composes:
 *     - `b.safeUrl.parse`       — `link_url` is https-only (or a
 *       /-rooted absolute path); javascript: / data: refused before
 *       persistence.
 *     - `b.crypto.namespaceHash`— SHA3-512 hash under the
 *       `announcement-bar-session-id` namespace; the only form the
 *       session id is persisted in.
 *     - `b.template.escapeHtml` — `renderHtml` escapes every operator-
 *       authored field so a hostile message / link_label lands as
 *       inert text in the storefront HTML.
 *
 *   Surface:
 *     - `defineAnnouncement({ slug, message, link_url?, link_label?,
 *                             theme, starts_at?, expires_at?, audience,
 *                             segment_slug?, dismissible })`
 *     - `activeAnnouncement({ now?, viewer_kind, customer_id?,
 *                             session_id? })`
 *     - `recordDismissal({ slug, session_id, occurred_at? })`
 *     - `getAnnouncement(slug)` / `listAnnouncements({ active_only? })`
 *     - `updateAnnouncement(slug, patch)` / `archiveAnnouncement(slug)`
 *     - `renderHtml({ announcement, locale? })` — sanitized HTML
 *       string ready for inline insertion into a storefront template.
 *
 *   Storage:
 *     - `migrations-d1/0180_announcement_bar.sql` — `announcements`
 *       (slug PK) + `announcement_dismissals` (FK CASCADE).
 *
 * @primitive announcementBar
 * @related   promoBanners, b.safeUrl, b.template.escapeHtml, b.crypto.namespaceHash
 */

// ---- constants ----------------------------------------------------------

var SESSION_HASH_NAMESPACE = "announcement-bar-session-id";

var MAX_SLUG_LEN       = 80;
var MAX_MESSAGE_LEN    = 240;
var MAX_LINK_URL_LEN   = 2048;
var MAX_LINK_LABEL_LEN = 80;
var MAX_SEGMENT_LEN    = 80;
var MAX_SESSION_ID_LEN = 256;

var ALLOWED_THEMES = Object.freeze(["info", "promo", "urgency", "success"]);

// Theme priority — higher number wins in activeAnnouncement. Urgency
// outranks promo (operator wants a "last day" warning to override the
// running sale strip); info and success are routine and yield to both.
var THEME_RANK = Object.freeze({
  urgency: 3,
  promo:   2,
  info:    1,
  success: 0,
});

var ALLOWED_AUDIENCES = Object.freeze(["all", "logged_in", "guest", "segment"]);

var ALLOWED_VIEWER_KINDS = Object.freeze(["logged_in", "guest"]);

// Slug shape mirrors promoBanners: leading alnum, then alnum / dot /
// underscore / hyphen, capped at 80 chars. The slug reaches operator-
// facing URLs in the admin dashboard so the shape stays narrow.
var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// Refuse C0 control bytes + DEL. Newlines are NOT allowed in
// `message` — the announcement is a single-line strip, never a
// paragraph; an embedded \n would either break the layout or be
// silently swallowed by CSS, both of which are surprising.
var CONTROL_BYTE_LINE_RE = /[\x00-\x1f\x7f]/;

// Zero-width / direction-override family — spelled with \u-escapes
// so ESLint's no-irregular-whitespace stays happy.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "message",
  "link_url",
  "link_label",
  "theme",
  "audience",
  "segment_slug",
  "starts_at",
  "expires_at",
  "dismissible",
]);

var b = require("./index").framework;

// ---- monotonic clock ----------------------------------------------------
//
// `defineAnnouncement` / `updateAnnouncement` / `recordDismissal` all
// persist epoch-ms timestamps. Operators occasionally edit the same
// announcement twice in the same millisecond (a typo fix immediately
// followed by an audience change); the activeAnnouncement tie-break
// is `updated_at DESC` so two same-ms updates would resolve
// non-deterministically. The strict-monotonic clock guarantees two
// `_now()` calls in the same millisecond produce distinct integers.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("announcementBar: " + (label || "slug") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (1.." + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _message(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_MESSAGE_LEN) {
    throw new TypeError("announcementBar: message must be a non-empty string <= " + MAX_MESSAGE_LEN + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("announcementBar: message must not contain control bytes (incl. CR/LF)");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("announcementBar: message must not contain zero-width / direction-override characters");
  }
  return s;
}

function _linkLabel(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_LINK_LABEL_LEN) {
    throw new TypeError("announcementBar: link_label must be a non-empty string <= " + MAX_LINK_LABEL_LEN + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("announcementBar: link_label must not contain control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("announcementBar: link_label must not contain zero-width / direction-override characters");
  }
  return s;
}

function _theme(s) {
  if (typeof s !== "string" || ALLOWED_THEMES.indexOf(s) === -1) {
    throw new TypeError("announcementBar: theme must be one of " + JSON.stringify(ALLOWED_THEMES));
  }
  return s;
}

function _audience(s) {
  if (typeof s !== "string" || ALLOWED_AUDIENCES.indexOf(s) === -1) {
    throw new TypeError("announcementBar: audience must be one of " + JSON.stringify(ALLOWED_AUDIENCES));
  }
  return s;
}

function _segmentSlug(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_SEGMENT_LEN) {
    throw new TypeError("announcementBar: segment_slug must be a non-empty string <= " + MAX_SEGMENT_LEN + " chars");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("announcementBar: segment_slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/");
  }
  return s;
}

function _viewerKind(s) {
  if (typeof s !== "string" || ALLOWED_VIEWER_KINDS.indexOf(s) === -1) {
    throw new TypeError("announcementBar: viewer_kind must be one of " + JSON.stringify(ALLOWED_VIEWER_KINDS));
  }
  return s;
}

function _epochOpt(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("announcementBar: " + label + " must be a non-negative integer (epoch ms) or null");
  }
  return n;
}

function _dismissible(v) {
  if (typeof v !== "boolean") {
    throw new TypeError("announcementBar: dismissible must be a boolean");
  }
  return v;
}

function _sessionId(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_SESSION_ID_LEN) {
    throw new TypeError("announcementBar: session_id must be a non-empty string <= " + MAX_SESSION_ID_LEN + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("announcementBar: session_id must not contain control bytes");
  }
  return s;
}

// Validate a link URL through `b.safeUrl.parse` (https-only) OR
// accept a /-rooted absolute path. Lands into an <a href="..."> on
// the storefront; javascript: / data: / vbscript: are refused by
// safeUrl's default protocol allowlist. Protocol-relative `//host/...`
// URLs are refused so a CDN mis-config can't downgrade the link.
function _linkUrl(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_LINK_URL_LEN) {
    throw new TypeError("announcementBar: link_url must be a non-empty string <= " + MAX_LINK_URL_LEN + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("announcementBar: link_url contains control / zero-width bytes");
  }
  if (s.charCodeAt(0) === 47 /* "/" */) {
    if (s.length > 1 && s.charCodeAt(1) === 47) {
      throw new TypeError("announcementBar: link_url protocol-relative `//host/...` refused — use absolute https://");
    }
    if (s.indexOf("..") !== -1) {
      throw new TypeError("announcementBar: link_url path must not contain '..'");
    }
    return s;
  }
  try {
    b.safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("announcementBar: link_url — " + (e && e.message || "must be https:// or a /-rooted absolute path"));
  }
  return s;
}

// link_url + link_label are coupled — both present or both NULL. The
// SQL CHECK constraint enforces the same invariant; the JS validator
// catches it earlier so the operator gets a clear error before the
// DB round-trip.
function _linkPair(linkUrl, linkLabel) {
  var urlPresent   = linkUrl   != null;
  var labelPresent = linkLabel != null;
  if (urlPresent !== labelPresent) {
    throw new TypeError("announcementBar: link_url and link_label must both be set or both be omitted");
  }
  if (!urlPresent) return { url: null, label: null };
  return { url: _linkUrl(linkUrl), label: _linkLabel(linkLabel) };
}

// ---- row hydration ------------------------------------------------------

function _hydrateRow(r) {
  if (!r) return null;
  return {
    slug:         r.slug,
    message:      r.message,
    link_url:     r.link_url,
    link_label:   r.link_label,
    theme:        r.theme,
    audience:     r.audience,
    segment_slug: r.segment_slug,
    starts_at:    r.starts_at  == null ? null : Number(r.starts_at),
    expires_at:   r.expires_at == null ? null : Number(r.expires_at),
    dismissible:  Number(r.dismissible) === 1,
    archived_at:  r.archived_at == null ? null : Number(r.archived_at),
    created_at:   Number(r.created_at),
    updated_at:   Number(r.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // customerSegments is optional — announcements with audience =
  // "segment" require it, but a deployment without segment-targeted
  // announcements can run without one. The factory captures the handle
  // and the `activeAnnouncement` path enforces the requirement lazily
  // with a clear error message when a segment-audience row is reached
  // without a segments handle wired up.
  var customerSegments = opts.customerSegments || null;

  // -- defineAnnouncement ----------------------------------------------

  async function defineAnnouncement(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("announcementBar.defineAnnouncement: input object required");
    }
    var slug        = _slug(input.slug);
    var message     = _message(input.message);
    var pair        = _linkPair(input.link_url, input.link_label);
    var theme       = _theme(input.theme);
    var audience    = _audience(input.audience);
    var segmentSlug;
    if (audience === "segment") {
      if (input.segment_slug == null) {
        throw new TypeError("announcementBar.defineAnnouncement: audience=\"segment\" requires segment_slug");
      }
      segmentSlug = _segmentSlug(input.segment_slug);
    } else {
      if (input.segment_slug != null) {
        throw new TypeError("announcementBar.defineAnnouncement: segment_slug only valid when audience=\"segment\"");
      }
      segmentSlug = null;
    }
    var startsAt    = _epochOpt(input.starts_at,  "starts_at");
    var expiresAt   = _epochOpt(input.expires_at, "expires_at");
    if (startsAt != null && expiresAt != null && expiresAt <= startsAt) {
      throw new TypeError("announcementBar.defineAnnouncement: expires_at must be strictly greater than starts_at");
    }
    var dismissible = _dismissible(input.dismissible);

    var existing = await _row(slug);
    var ts = _now();
    if (existing) {
      if (existing.archived_at != null) {
        throw new TypeError("announcementBar.defineAnnouncement: slug " + JSON.stringify(slug) + " is archived");
      }
      await query(
        "UPDATE announcements " +
        "SET message = ?1, link_url = ?2, link_label = ?3, theme = ?4, audience = ?5, " +
        "    segment_slug = ?6, starts_at = ?7, expires_at = ?8, dismissible = ?9, updated_at = ?10 " +
        "WHERE slug = ?11",
        [message, pair.url, pair.label, theme, audience, segmentSlug,
         startsAt, expiresAt, dismissible ? 1 : 0, ts, slug],
      );
    } else {
      await query(
        "INSERT INTO announcements " +
        "(slug, message, link_url, link_label, theme, audience, segment_slug, " +
        " starts_at, expires_at, dismissible, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?11)",
        [slug, message, pair.url, pair.label, theme, audience, segmentSlug,
         startsAt, expiresAt, dismissible ? 1 : 0, ts],
      );
    }
    return _hydrateRow(await _row(slug));
  }

  async function _row(slug) {
    var r = await query("SELECT * FROM announcements WHERE slug = ?1 LIMIT 1", [slug]);
    return r.rows[0] || null;
  }

  // -- getAnnouncement / listAnnouncements -----------------------------

  async function getAnnouncement(slug) {
    _slug(slug);
    return _hydrateRow(await _row(slug));
  }

  async function listAnnouncements(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      if (typeof listOpts.active_only !== "boolean") {
        throw new TypeError("announcementBar.listAnnouncements: active_only must be a boolean");
      }
      activeOnly = listOpts.active_only;
    }
    var sql, params;
    if (activeOnly) {
      var nowTs = _now();
      sql = "SELECT * FROM announcements " +
            "WHERE archived_at IS NULL " +
            "  AND (starts_at  IS NULL OR starts_at  <= ?1) " +
            "  AND (expires_at IS NULL OR expires_at >  ?1) " +
            "ORDER BY updated_at DESC, slug ASC";
      params = [nowTs];
    } else {
      sql    = "SELECT * FROM announcements ORDER BY updated_at DESC, slug ASC";
      params = [];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRow(rows[i]));
    return out;
  }

  // -- updateAnnouncement ----------------------------------------------

  async function updateAnnouncement(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("announcementBar.updateAnnouncement: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("announcementBar.updateAnnouncement: patch must include at least one column");
    }
    // Resolve the existing row first so cross-column invariants
    // (audience <-> segment_slug, link_url <-> link_label, starts_at
    // < expires_at) can be checked against the post-patch state
    // without a mid-UPDATE re-read.
    var current = await getAnnouncement(slug);
    if (!current) {
      throw new TypeError("announcementBar.updateAnnouncement: slug " + JSON.stringify(slug) + " not found");
    }
    if (current.archived_at != null) {
      throw new TypeError("announcementBar.updateAnnouncement: slug " + JSON.stringify(slug) + " is archived");
    }

    var sets   = [];
    var params = [];
    var idx    = 1;
    var postAudience    = current.audience;
    var postSegmentSlug = current.segment_slug;
    var postStartsAt    = current.starts_at;
    var postExpiresAt   = current.expires_at;
    var postLinkUrl     = current.link_url;
    var postLinkLabel   = current.link_label;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("announcementBar.updateAnnouncement: unsupported column " + JSON.stringify(col));
      }
      var v;
      if      (col === "message")      { v = _message(patch[col]); }
      else if (col === "link_url")     { v = patch[col] == null ? null : _linkUrl(patch[col]);    postLinkUrl   = v; }
      else if (col === "link_label")   { v = patch[col] == null ? null : _linkLabel(patch[col]);  postLinkLabel = v; }
      else if (col === "theme")        { v = _theme(patch[col]); }
      else if (col === "audience")     { v = _audience(patch[col]);    postAudience    = v; }
      else if (col === "segment_slug") { v = patch[col] == null ? null : _segmentSlug(patch[col]); postSegmentSlug = v; }
      else if (col === "starts_at")    { v = _epochOpt(patch[col], "starts_at");   postStartsAt  = v; }
      else if (col === "expires_at")   { v = _epochOpt(patch[col], "expires_at");  postExpiresAt = v; }
      else /* dismissible */           { v = _dismissible(patch[col]) ? 1 : 0; }
      sets.push(col + " = ?" + idx);
      params.push(v);
      idx += 1;
    }

    if (postAudience === "segment" && postSegmentSlug == null) {
      throw new TypeError("announcementBar.updateAnnouncement: audience=\"segment\" requires segment_slug");
    }
    if (postAudience !== "segment" && postSegmentSlug != null) {
      throw new TypeError("announcementBar.updateAnnouncement: segment_slug only valid when audience=\"segment\"");
    }
    if ((postLinkUrl == null) !== (postLinkLabel == null)) {
      throw new TypeError("announcementBar.updateAnnouncement: link_url and link_label must both be set or both be omitted");
    }
    if (postStartsAt != null && postExpiresAt != null && postExpiresAt <= postStartsAt) {
      throw new TypeError("announcementBar.updateAnnouncement: expires_at must be strictly greater than starts_at");
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE announcements SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("announcementBar.updateAnnouncement: slug " + JSON.stringify(slug) + " not found");
    }
    return await getAnnouncement(slug);
  }

  // -- archiveAnnouncement ---------------------------------------------

  async function archiveAnnouncement(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE announcements SET archived_at = ?1, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getAnnouncement(slug);
      if (!existing) {
        throw new TypeError("announcementBar.archiveAnnouncement: slug " + JSON.stringify(slug) + " not found");
      }
      // Already archived — return idempotently so an operator running
      // an "archive everything past expiry" sweep doesn't have to
      // special-case rows a coworker already archived.
      return existing;
    }
    return await getAnnouncement(slug);
  }

  // -- activeAnnouncement ----------------------------------------------

  async function activeAnnouncement(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("announcementBar.activeAnnouncement: input object required");
    }
    var viewerKind = _viewerKind(input.viewer_kind);
    var nowTs;
    if (input.now == null) {
      nowTs = _now();
    } else {
      nowTs = _epochOpt(input.now, "now");
      if (nowTs == null) nowTs = _now();
    }
    var customerId = null;
    if (input.customer_id != null) {
      if (typeof input.customer_id !== "string" || !input.customer_id.length) {
        throw new TypeError("announcementBar.activeAnnouncement: customer_id must be a non-empty string when provided");
      }
      customerId = input.customer_id;
    }
    if (viewerKind === "logged_in" && customerId == null) {
      throw new TypeError("announcementBar.activeAnnouncement: viewer_kind=\"logged_in\" requires customer_id");
    }
    if (viewerKind === "guest" && customerId != null) {
      throw new TypeError("announcementBar.activeAnnouncement: viewer_kind=\"guest\" must not carry customer_id");
    }
    var sessionHash = null;
    if (input.session_id != null) {
      var sid = _sessionId(input.session_id);
      sessionHash = b.crypto.namespaceHash(SESSION_HASH_NAMESPACE, sid);
    }

    // Pull every candidate row in the active window, ordered by
    // updated_at DESC then slug ASC. The theme rank is applied JS-
    // side so it doesn't depend on a CASE expression that varies
    // across SQL dialects.
    var rows = (await query(
      "SELECT * FROM announcements " +
      "WHERE archived_at IS NULL " +
      "  AND (starts_at  IS NULL OR starts_at  <= ?1) " +
      "  AND (expires_at IS NULL OR expires_at >  ?1) " +
      "ORDER BY updated_at DESC, slug ASC",
      [nowTs],
    )).rows;

    if (!rows.length) return null;

    // Pull dismissals for this session once (single query), then
    // skip any candidate whose slug appears in the set. The session
    // is unhashed at the boundary; the DB only ever sees the digest.
    var dismissedSet = null;
    if (sessionHash != null) {
      var dRows = (await query(
        "SELECT announcement_slug FROM announcement_dismissals WHERE session_id_hash = ?1",
        [sessionHash],
      )).rows;
      dismissedSet = Object.create(null);
      for (var d = 0; d < dRows.length; d += 1) dismissedSet[dRows[d].announcement_slug] = true;
    }

    // Walk candidates in (theme_rank DESC, updated_at DESC, slug ASC)
    // order. We've already sorted by (updated_at DESC, slug ASC) at
    // the SQL layer, so we just need to find the row with the
    // highest theme rank that passes the audience + dismissal filter,
    // breaking ties using the SQL-supplied order (which is stable).
    var best = null;
    var bestRank = -1;
    for (var i = 0; i < rows.length; i += 1) {
      var hydrated = _hydrateRow(rows[i]);

      // Audience gate.
      if (hydrated.audience === "logged_in" && viewerKind !== "logged_in") continue;
      if (hydrated.audience === "guest"     && viewerKind !== "guest")     continue;
      if (hydrated.audience === "segment") {
        if (viewerKind !== "logged_in") continue;
        if (!customerSegments) {
          throw new TypeError("announcementBar.activeAnnouncement: announcement " + JSON.stringify(hydrated.slug) +
            " has audience=\"segment\" but no customerSegments handle was wired into create()");
        }
        if (typeof customerSegments.isMember !== "function") {
          throw new TypeError("announcementBar.activeAnnouncement: customerSegments handle must expose isMember(customer_id, segment_slug)");
        }
        var member = await customerSegments.isMember(customerId, hydrated.segment_slug);
        if (!member) continue;
      }

      // Dismissal gate. Only applies when the storefront passes a
      // session_id; a viewer with no session can't have dismissed
      // anything yet, so the gate is a no-op for them.
      if (dismissedSet && dismissedSet[hydrated.slug]) continue;

      var rank = THEME_RANK[hydrated.theme];
      if (rank == null) rank = -1;
      if (rank > bestRank) {
        best = hydrated;
        bestRank = rank;
      }
    }
    return best;
  }

  // -- recordDismissal --------------------------------------------------

  async function recordDismissal(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("announcementBar.recordDismissal: input object required");
    }
    var slug      = _slug(input.slug);
    var sessionId = _sessionId(input.session_id);
    var occurredAt = input.occurred_at == null ? _now() : _epochOpt(input.occurred_at, "occurred_at");
    if (occurredAt == null) occurredAt = _now();

    // Confirm the announcement exists so the dismissal log never
    // accumulates orphan rows. (The FK enforces it at the DB layer;
    // the JS check produces a clearer error message.)
    var row = await _row(slug);
    if (!row) {
      throw new TypeError("announcementBar.recordDismissal: slug " + JSON.stringify(slug) + " not found");
    }

    var hash = b.crypto.namespaceHash(SESSION_HASH_NAMESPACE, sessionId);

    // Dedup is enforced by the UNIQUE(announcement_slug,
    // session_id_hash) index; a second dismissal from the same
    // session is a no-op (the existing row keeps its occurred_at).
    // INSERT OR IGNORE keeps the call idempotent without a separate
    // SELECT-then-INSERT round-trip.
    var id = b.uuid.v7();
    var r = await query(
      "INSERT OR IGNORE INTO announcement_dismissals " +
      "(id, announcement_slug, session_id_hash, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4)",
      [id, slug, hash, occurredAt],
    );
    var inserted = Number(r.rowCount || 0) > 0;

    return {
      announcement_slug: slug,
      session_id_hash:   hash,
      occurred_at:       occurredAt,
      recorded:          inserted,
    };
  }

  // -- renderHtml -------------------------------------------------------

  function renderHtml(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("announcementBar.renderHtml: input object required");
    }
    var announcement = input.announcement;
    if (!announcement || typeof announcement !== "object") {
      throw new TypeError("announcementBar.renderHtml: announcement object required");
    }
    var locale = input.locale;
    if (locale != null) {
      if (typeof locale !== "string" || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) {
        throw new TypeError("announcementBar.renderHtml: locale must be a BCP-47-shape string (e.g. 'en-US')");
      }
    }
    var escapeHtml = b.template.escapeHtml;

    var theme      = escapeHtml(announcement.theme || "info");
    var slug       = escapeHtml(announcement.slug);
    var message    = escapeHtml(announcement.message);
    var localeAttr = locale ? ' lang="' + escapeHtml(locale) + '"' : "";

    var parts = [];
    parts.push('<div class="announcement-bar announcement-bar--' + theme +
               '" data-announcement-slug="' + slug + '"' +
               (announcement.dismissible ? ' data-dismissible="true"' : "") +
               localeAttr + '>');
    parts.push('<span class="announcement-bar__message">' + message + '</span>');
    if (announcement.link_url && announcement.link_label) {
      parts.push('<a class="announcement-bar__cta" href="' + escapeHtml(announcement.link_url) +
                 '" data-announcement-slug="' + slug + '">' +
                 escapeHtml(announcement.link_label) + '</a>');
    }
    if (announcement.dismissible) {
      parts.push('<button type="button" class="announcement-bar__dismiss" ' +
                 'data-announcement-slug="' + slug + '" aria-label="Dismiss announcement">&times;</button>');
    }
    parts.push('</div>');
    return parts.join("");
  }

  return {
    MAX_SLUG_LEN:           MAX_SLUG_LEN,
    MAX_MESSAGE_LEN:        MAX_MESSAGE_LEN,
    MAX_LINK_URL_LEN:       MAX_LINK_URL_LEN,
    MAX_LINK_LABEL_LEN:     MAX_LINK_LABEL_LEN,
    ALLOWED_THEMES:         ALLOWED_THEMES,
    ALLOWED_AUDIENCES:      ALLOWED_AUDIENCES,
    SESSION_HASH_NAMESPACE: SESSION_HASH_NAMESPACE,

    defineAnnouncement:  defineAnnouncement,
    activeAnnouncement:  activeAnnouncement,
    recordDismissal:     recordDismissal,
    getAnnouncement:     getAnnouncement,
    listAnnouncements:   listAnnouncements,
    updateAnnouncement:  updateAnnouncement,
    archiveAnnouncement: archiveAnnouncement,
    renderHtml:          renderHtml,
  };
}

module.exports = {
  create:                 create,
  MAX_SLUG_LEN:           MAX_SLUG_LEN,
  MAX_MESSAGE_LEN:        MAX_MESSAGE_LEN,
  MAX_LINK_URL_LEN:       MAX_LINK_URL_LEN,
  MAX_LINK_LABEL_LEN:     MAX_LINK_LABEL_LEN,
  ALLOWED_THEMES:         ALLOWED_THEMES,
  ALLOWED_AUDIENCES:      ALLOWED_AUDIENCES,
  SESSION_HASH_NAMESPACE: SESSION_HASH_NAMESPACE,
};
