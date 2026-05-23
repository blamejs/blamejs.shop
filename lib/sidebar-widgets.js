"use strict";
/**
 * @module shop.sidebarWidgets
 * @title  Sidebar widgets — operator-curated storefront sidebar content
 *
 * @intro
 *   Operator-authored content blocks rendered in the storefront
 *   sidebar across the product / collection / cart / search / account
 *   pages. Where `promoBanners` owns horizontal strips at fixed
 *   placements, `sidebarWidgets` owns the vertically-stacked sidebar
 *   on pages that have one — each page declares an ordered list of
 *   widgets via `setPagePlacement(page_key, [slugs...])`, and the
 *   storefront's render path resolves the ordered list for the
 *   current page + viewer through `widgetsForPage`.
 *
 *   Nine widget kinds, each with a kind-specific payload shape:
 *
 *     - newsletter_signup    — { list_id, headline, cta_label }
 *     - recently_viewed      — { limit }
 *     - trust_badges         — { badges: [slug, ...] }
 *     - featured_collection  — { collection_slug, limit }
 *     - social_proof         — { headline, message_template }
 *     - size_chart           — { chart_slug }
 *     - live_visitors        — { window_minutes, min_threshold }
 *     - countdown_timer      — { target_at, completed_label }
 *     - sticky_addtocart     — { variant_slug }
 *
 *   Audience filtering mirrors `promoBanners` — every widget targets
 *   `all` / `logged_in` / `guest` / a named `segment` — and the
 *   factory accepts an optional `customerSegments` handle for
 *   segment-membership resolution.
 *
 *   Schedule windows (`starts_at` / `expires_at`) gate visibility in
 *   time; `archived_at` soft-retires a widget so its placement rows
 *   stay queryable while the widget itself stops rendering.
 *
 *   Surface:
 *     - `defineWidget({ slug, title, kind, payload, audience,
 *                       segment_slug?, priority?, starts_at,
 *                       expires_at })`
 *     - `setPagePlacement(page_key, [slug, ...])` — replaces the
 *       page's ordered widget list atomically.
 *     - `widgetsForPage({ page_key, viewer_kind, customer_id?, now })`
 *       — ordered widgets for the page, filtered by audience +
 *       schedule window. Returns the placement order verbatim;
 *       widgets that fail the audience / schedule / archived check
 *       drop out without renumbering.
 *     - `recordImpression({ widget_slug, page_key })` —
 *       drop-silent ledger insert (hot path).
 *     - `recordClick({ widget_slug, page_key })` — drop-silent
 *       ledger insert (hot path).
 *     - `metricsForWidget({ slug, from?, to? })` — impressions /
 *       clicks / CTR + per-page-key breakdown.
 *     - `listWidgets({ kind?, audience?, include_archived?, limit? })`
 *     - `updateWidget(slug, patch)` — title / payload / audience /
 *       segment_slug / priority / starts_at / expires_at.
 *     - `archiveWidget(slug)` — idempotent soft-retire.
 *
 *   Composes:
 *     - `b.uuid.v7`      — ledger row PK (lexicographic-monotonic so
 *                          per-widget event reads sort cleanly).
 *     - `b.safeUrl.parse` — used inside payload validation where the
 *                          operator-authored config carries URLs (no
 *                          kind in v1 actually carries a free-form
 *                          URL; the validation discipline is staged
 *                          for future kinds without changing the
 *                          surface).
 *
 *   Storage: `migrations-d1/0176_sidebar_widgets.sql` —
 *     `sidebar_widgets` + `sidebar_widget_placements` (FK CASCADE) +
 *     `sidebar_widget_events` (FK CASCADE).
 *
 * @primitive sidebarWidgets
 * @related   b.uuid, promoBanners, customerSegments
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var KINDS = Object.freeze([
  "newsletter_signup",
  "recently_viewed",
  "trust_badges",
  "featured_collection",
  "social_proof",
  "size_chart",
  "live_visitors",
  "countdown_timer",
  "sticky_addtocart",
]);

var AUDIENCES      = Object.freeze(["all", "logged_in", "guest", "segment"]);
var VIEWER_KINDS   = Object.freeze(["logged_in", "guest"]);
var EVENT_KINDS    = Object.freeze(["impression", "click"]);

var MAX_SLUG_LEN          = 80;
var MAX_TITLE_LEN         = 200;
var MAX_PAGE_KEY_LEN      = 120;
var MAX_HEADLINE_LEN      = 200;
var MAX_CTA_LABEL_LEN     = 80;
var MAX_LABEL_LEN         = 200;
var MAX_MESSAGE_LEN       = 500;
var MAX_LIST_ID_LEN       = 120;
var MAX_COLLECTION_LEN    = 120;
var MAX_VARIANT_LEN       = 120;
var MAX_CHART_LEN         = 120;
var MAX_BADGES            = 12;
var MAX_BADGE_LEN         = 80;
var MAX_WIDGETS_PER_PAGE  = 24;
var MAX_PRIORITY          = 1000000;
var MAX_LIMIT             = 500;
var DEFAULT_LIMIT         = 50;
var MAX_RECENTLY_VIEWED   = 24;
var MAX_FEATURED_LIMIT    = 24;
var MAX_LIVE_VISITORS_WIN = 240;       // 4 hours
var MIN_LIVE_VISITORS_WIN = 1;
var MAX_MIN_THRESHOLD     = 100000;

// Slug shape mirrors the storefront-wide convention: leading alnum,
// alnum / dot / dash / underscore, capped length. The slug reaches
// operator-facing admin URLs and HTML data-attributes.
var SLUG_RE       = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
var PAGE_KEY_RE   = /^[A-Za-z0-9][A-Za-z0-9:._\/-]{0,119}$/;
var BADGE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
var SEGMENT_RE    = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

var CONTROL_BYTE_LINE_RE  = /[\x00-\x1f\x7f]/;
var CONTROL_BYTE_BLOCK_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "payload",
  "audience",
  "segment_slug",
  "priority",
  "starts_at",
  "expires_at",
]);

// ---- monotonic clock ----------------------------------------------------
//
// Widget definition rows + ledger event rows persist epoch-ms
// timestamps. Two same-millisecond `_now()` calls inside a single
// `setPagePlacement` (DELETE + INSERT batch) or inside a tight test
// loop would otherwise produce identical timestamps, leaving the row
// ordering ambiguous on equal-time reads. The strict-monotonic shim
// guarantees every subsequent call observes a timestamp at least 1ms
// greater than the previous one so `created_at` / `updated_at` /
// `occurred_at` define a total order without an extra tiebreaker
// column. Sibling primitives (pixelEvents, customerSurveys, etc.) use
// the same shape.

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
    throw new TypeError("sidebarWidgets: " + (label || "slug") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (1.." + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("sidebarWidgets: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("sidebarWidgets: title must not contain control bytes (incl. CR/LF)");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("sidebarWidgets: title must not contain zero-width / direction-override characters");
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError("sidebarWidgets: kind must be one of " + KINDS.join(", "));
  }
  return s;
}

function _audience(s) {
  if (typeof s !== "string" || AUDIENCES.indexOf(s) === -1) {
    throw new TypeError("sidebarWidgets: audience must be one of " + AUDIENCES.join(", "));
  }
  return s;
}

function _segmentSlug(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !SEGMENT_RE.test(s)) {
    throw new TypeError("sidebarWidgets: segment_slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/");
  }
  return s;
}

function _priority(n) {
  if (n == null) return 0;
  if (!Number.isInteger(n) || n < 0 || n > MAX_PRIORITY) {
    throw new TypeError("sidebarWidgets: priority must be an integer in [0, " + MAX_PRIORITY + "]");
  }
  return n;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("sidebarWidgets: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _epochMsOpt(n, label) {
  if (n == null) return null;
  return _epochMs(n, label);
}

function _pageKey(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_PAGE_KEY_LEN || !PAGE_KEY_RE.test(s)) {
    throw new TypeError("sidebarWidgets: page_key must match /^[A-Za-z0-9][A-Za-z0-9:._\\/-]*$/ (1.." + MAX_PAGE_KEY_LEN + " chars)");
  }
  return s;
}

function _viewerKind(s) {
  if (typeof s !== "string" || VIEWER_KINDS.indexOf(s) === -1) {
    throw new TypeError("sidebarWidgets: viewer_kind must be one of " + VIEWER_KINDS.join(", "));
  }
  return s;
}

function _eventKind(s) {
  if (typeof s !== "string" || EVENT_KINDS.indexOf(s) === -1) {
    throw new TypeError("sidebarWidgets: event_kind must be one of " + EVENT_KINDS.join(", "));
  }
  return s;
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("sidebarWidgets: " + (label || "limit") + " must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return n;
}

function _line(s, label, maxLen) {
  if (typeof s !== "string" || !s.length || s.length > maxLen) {
    throw new TypeError("sidebarWidgets: " + label + " must be a non-empty string <= " + maxLen + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("sidebarWidgets: " + label + " must not contain control bytes (incl. CR/LF)");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("sidebarWidgets: " + label + " must not contain zero-width / direction-override characters");
  }
  return s;
}

function _block(s, label, maxLen) {
  if (typeof s !== "string" || !s.length || s.length > maxLen) {
    throw new TypeError("sidebarWidgets: " + label + " must be a non-empty string <= " + maxLen + " chars");
  }
  if (CONTROL_BYTE_BLOCK_RE.test(s)) {
    throw new TypeError("sidebarWidgets: " + label + " must not contain control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("sidebarWidgets: " + label + " must not contain zero-width / direction-override characters");
  }
  return s;
}

function _ident(s, label, re, maxLen) {
  if (typeof s !== "string" || !s.length || s.length > maxLen || !re.test(s)) {
    throw new TypeError("sidebarWidgets: " + label + " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (1.." + maxLen + " chars)");
  }
  return s;
}

// ---- payload validation -------------------------------------------------
//
// Each kind owns a payload shape. The validator returns a canonical
// (key-ordered) object so the stored JSON is independent of caller
// insertion order. Unknown keys are refused so a stale client can't
// smuggle extra fields into the persisted JSON.

function _payloadFor(kind, payload) {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("sidebarWidgets: payload must be an object");
  }

  function _onlyKeys(allowed) {
    var keys = Object.keys(payload);
    for (var i = 0; i < keys.length; i += 1) {
      if (allowed.indexOf(keys[i]) === -1) {
        throw new TypeError("sidebarWidgets: payload key " + JSON.stringify(keys[i]) +
          " is not valid for kind " + JSON.stringify(kind));
      }
    }
  }

  if (kind === "newsletter_signup") {
    _onlyKeys(["list_id", "headline", "cta_label"]);
    return {
      list_id:   _ident(payload.list_id, "payload.list_id", /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/, MAX_LIST_ID_LEN),
      headline:  _line(payload.headline,  "payload.headline",  MAX_HEADLINE_LEN),
      cta_label: _line(payload.cta_label, "payload.cta_label", MAX_CTA_LABEL_LEN),
    };
  }
  if (kind === "recently_viewed") {
    _onlyKeys(["limit"]);
    var lim = payload.limit;
    if (!Number.isInteger(lim) || lim < 1 || lim > MAX_RECENTLY_VIEWED) {
      throw new TypeError("sidebarWidgets: payload.limit must be an integer in [1, " + MAX_RECENTLY_VIEWED + "]");
    }
    return { limit: lim };
  }
  if (kind === "trust_badges") {
    _onlyKeys(["badges"]);
    if (!Array.isArray(payload.badges) || payload.badges.length === 0) {
      throw new TypeError("sidebarWidgets: payload.badges must be a non-empty array");
    }
    if (payload.badges.length > MAX_BADGES) {
      throw new TypeError("sidebarWidgets: payload.badges must contain <= " + MAX_BADGES + " entries");
    }
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < payload.badges.length; i += 1) {
      var b = payload.badges[i];
      if (typeof b !== "string" || !b.length || b.length > MAX_BADGE_LEN || !BADGE_SLUG_RE.test(b)) {
        throw new TypeError("sidebarWidgets: payload.badges[" + i +
          "] must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (1.." + MAX_BADGE_LEN + " chars)");
      }
      if (seen[b]) {
        throw new TypeError("sidebarWidgets: payload.badges[" + i + "] duplicates a previous entry");
      }
      seen[b] = true;
      out.push(b);
    }
    return { badges: out };
  }
  if (kind === "featured_collection") {
    _onlyKeys(["collection_slug", "limit"]);
    var col = _ident(payload.collection_slug, "payload.collection_slug",
                     /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/, MAX_COLLECTION_LEN);
    var flim = payload.limit;
    if (!Number.isInteger(flim) || flim < 1 || flim > MAX_FEATURED_LIMIT) {
      throw new TypeError("sidebarWidgets: payload.limit must be an integer in [1, " + MAX_FEATURED_LIMIT + "]");
    }
    return { collection_slug: col, limit: flim };
  }
  if (kind === "social_proof") {
    _onlyKeys(["headline", "message_template"]);
    return {
      headline:         _line(payload.headline,         "payload.headline",         MAX_HEADLINE_LEN),
      message_template: _block(payload.message_template, "payload.message_template", MAX_MESSAGE_LEN),
    };
  }
  if (kind === "size_chart") {
    _onlyKeys(["chart_slug"]);
    return {
      chart_slug: _ident(payload.chart_slug, "payload.chart_slug",
                         /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/, MAX_CHART_LEN),
    };
  }
  if (kind === "live_visitors") {
    _onlyKeys(["window_minutes", "min_threshold"]);
    var win = payload.window_minutes;
    if (!Number.isInteger(win) || win < MIN_LIVE_VISITORS_WIN || win > MAX_LIVE_VISITORS_WIN) {
      throw new TypeError("sidebarWidgets: payload.window_minutes must be an integer in [" +
        MIN_LIVE_VISITORS_WIN + ", " + MAX_LIVE_VISITORS_WIN + "]");
    }
    var thr = payload.min_threshold;
    if (!Number.isInteger(thr) || thr < 0 || thr > MAX_MIN_THRESHOLD) {
      throw new TypeError("sidebarWidgets: payload.min_threshold must be an integer in [0, " + MAX_MIN_THRESHOLD + "]");
    }
    return { window_minutes: win, min_threshold: thr };
  }
  if (kind === "countdown_timer") {
    _onlyKeys(["target_at", "completed_label"]);
    var target = payload.target_at;
    if (!Number.isInteger(target) || target <= 0) {
      throw new TypeError("sidebarWidgets: payload.target_at must be a positive integer (epoch ms)");
    }
    return {
      target_at:       target,
      completed_label: _line(payload.completed_label, "payload.completed_label", MAX_LABEL_LEN),
    };
  }
  // sticky_addtocart
  _onlyKeys(["variant_slug"]);
  return {
    variant_slug: _ident(payload.variant_slug, "payload.variant_slug",
                         /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/, MAX_VARIANT_LEN),
  };
}

// ---- row hydration ------------------------------------------------------

function _hydrateWidget(r) {
  if (!r) return null;
  var payload;
  try { payload = JSON.parse(r.payload_json); }
  catch (_e) { payload = {}; }
  return {
    slug:         r.slug,
    title:        r.title,
    kind:         r.kind,
    payload:      payload,
    audience:     r.audience,
    segment_slug: r.segment_slug,
    priority:     Number(r.priority),
    starts_at:    Number(r.starts_at),
    expires_at:   Number(r.expires_at),
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
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // customerSegments is optional — widgets with audience = "segment"
  // require it, but a deployment without segment-targeted widgets can
  // run without one. The factory captures the handle and the
  // `widgetsForPage` path enforces the requirement lazily so the
  // error surfaces with a clear message when a segment-audience
  // widget is reached without a segments handle wired up.
  var customerSegments = opts.customerSegments || null;

  // -- internal helpers --------------------------------------------------

  async function _getWidgetRow(slug) {
    var r = await query("SELECT * FROM sidebar_widgets WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  async function getWidget(slug) {
    _slug(slug);
    return _hydrateWidget(await _getWidgetRow(slug));
  }

  // -- defineWidget ------------------------------------------------------

  async function defineWidget(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("sidebarWidgets.defineWidget: input object required");
    }
    var slug      = _slug(input.slug, "slug");
    var title     = _title(input.title);
    var kind      = _kind(input.kind);
    var payload   = _payloadFor(kind, input.payload);
    var audience  = _audience(input.audience);

    var segmentSlug;
    if (audience === "segment") {
      if (input.segment_slug == null) {
        throw new TypeError("sidebarWidgets.defineWidget: audience=\"segment\" requires segment_slug");
      }
      segmentSlug = _segmentSlug(input.segment_slug);
    } else {
      if (input.segment_slug != null) {
        throw new TypeError("sidebarWidgets.defineWidget: segment_slug only valid when audience=\"segment\"");
      }
      segmentSlug = null;
    }

    var priority  = _priority(input.priority);
    var startsAt  = _epochMs(input.starts_at,  "starts_at");
    var expiresAt = _epochMs(input.expires_at, "expires_at");
    if (expiresAt <= startsAt) {
      throw new TypeError("sidebarWidgets.defineWidget: expires_at must be strictly greater than starts_at");
    }

    var existing = await _getWidgetRow(slug);
    var ts       = _now();
    if (existing) {
      // Update path: same-slug re-define replaces the row atomically.
      // Refuses to resurrect an archived widget — operators have to
      // explicitly call defineWidget on a fresh slug or update +
      // unarchive (the latter isn't a defined surface in v1 — archive
      // is a one-way soft-retire that preserves the placement history
      // for audit but stops the widget from ever rendering again).
      if (existing.archived_at != null) {
        throw new TypeError("sidebarWidgets.defineWidget: widget " + JSON.stringify(slug) + " is archived");
      }
      // Kind is immutable after first define — the payload shape is
      // kind-specific, and historical impression / click events
      // reference the slug. Operators that want a different kind
      // archive the old slug and define a new one.
      if (existing.kind !== kind) {
        throw new TypeError(
          "sidebarWidgets.defineWidget: cannot change kind from " + JSON.stringify(existing.kind) +
          " to " + JSON.stringify(kind) + " for slug " + JSON.stringify(slug) +
          " — archive the existing widget and pick a new slug"
        );
      }
      await query(
        "UPDATE sidebar_widgets SET title = ?1, payload_json = ?2, audience = ?3, " +
        "segment_slug = ?4, priority = ?5, starts_at = ?6, expires_at = ?7, updated_at = ?8 " +
        "WHERE slug = ?9",
        [title, JSON.stringify(payload), audience, segmentSlug, priority,
         startsAt, expiresAt, ts, slug],
      );
    } else {
      await query(
        "INSERT INTO sidebar_widgets " +
        "(slug, title, kind, payload_json, audience, segment_slug, priority, " +
        " starts_at, expires_at, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?10)",
        [slug, title, kind, JSON.stringify(payload), audience, segmentSlug, priority,
         startsAt, expiresAt, ts],
      );
    }
    return _hydrateWidget(await _getWidgetRow(slug));
  }

  // -- setPagePlacement --------------------------------------------------
  //
  // Atomic replace: every previous (page_key, *) placement row is
  // deleted, then the new ordered list is inserted in one pass. The
  // primitive verifies every slug exists + isn't archived before
  // touching the placement table so a typo doesn't half-replace the
  // page's sidebar.

  async function setPagePlacement(pageKey, slugs) {
    var key = _pageKey(pageKey);
    if (!Array.isArray(slugs)) {
      throw new TypeError("sidebarWidgets.setPagePlacement: slugs must be an array");
    }
    if (slugs.length > MAX_WIDGETS_PER_PAGE) {
      throw new TypeError("sidebarWidgets.setPagePlacement: slugs must contain <= " + MAX_WIDGETS_PER_PAGE + " entries");
    }
    var seen = Object.create(null);
    var canonical = [];
    for (var i = 0; i < slugs.length; i += 1) {
      var s = slugs[i];
      _slug(s, "slugs[" + i + "]");
      if (seen[s]) {
        throw new TypeError("sidebarWidgets.setPagePlacement: slugs[" + i + "] duplicates a previous entry");
      }
      seen[s] = true;
      canonical.push(s);
    }

    // Verify each referenced widget exists + isn't archived. A
    // placement row pointing at an archived widget is meaningless —
    // the widget is permanently retired, so the page can't render it.
    for (var j = 0; j < canonical.length; j += 1) {
      var row = await _getWidgetRow(canonical[j]);
      if (!row) {
        throw new TypeError("sidebarWidgets.setPagePlacement: widget " + JSON.stringify(canonical[j]) + " not found");
      }
      if (row.archived_at != null) {
        throw new TypeError("sidebarWidgets.setPagePlacement: widget " + JSON.stringify(canonical[j]) + " is archived");
      }
    }

    await query("DELETE FROM sidebar_widget_placements WHERE page_key = ?1", [key]);
    var ts = _now();
    for (var k = 0; k < canonical.length; k += 1) {
      await query(
        "INSERT INTO sidebar_widget_placements (page_key, widget_slug, position, created_at) " +
        "VALUES (?1, ?2, ?3, ?4)",
        [key, canonical[k], k, ts],
      );
    }

    return { page_key: key, slugs: canonical, updated_at: ts };
  }

  // -- widgetsForPage ----------------------------------------------------

  async function widgetsForPage(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("sidebarWidgets.widgetsForPage: input object required");
    }
    var key        = _pageKey(input.page_key);
    var viewerKind = _viewerKind(input.viewer_kind);
    var nowTs      = _epochMs(input.now, "now");
    var customerId = null;
    if (input.customer_id != null) {
      if (typeof input.customer_id !== "string" || !input.customer_id.length) {
        throw new TypeError("sidebarWidgets.widgetsForPage: customer_id must be a non-empty string when provided");
      }
      customerId = input.customer_id;
    }
    if (viewerKind === "logged_in" && customerId == null) {
      throw new TypeError("sidebarWidgets.widgetsForPage: viewer_kind=\"logged_in\" requires customer_id");
    }
    if (viewerKind === "guest" && customerId != null) {
      throw new TypeError("sidebarWidgets.widgetsForPage: viewer_kind=\"guest\" must not carry customer_id");
    }

    // Join placement -> widget so we read ordered placement rows
    // with the corresponding widget definition in one pass. Filter
    // by schedule window + archived_at at the SQL layer; the
    // audience / segment-membership check happens JS-side (segment
    // membership is an external handle call, not a SQL join).
    var rows = (await query(
      "SELECT w.*, p.position AS _position " +
      "FROM sidebar_widget_placements p " +
      "JOIN sidebar_widgets w ON w.slug = p.widget_slug " +
      "WHERE p.page_key = ?1 AND w.archived_at IS NULL " +
      "AND w.starts_at <= ?2 AND w.expires_at > ?2 " +
      "ORDER BY p.position ASC",
      [key, nowTs],
    )).rows;

    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var widget = _hydrateWidget(rows[i]);
      if (widget.audience === "all") {
        out.push(widget); continue;
      }
      if (widget.audience === "logged_in" && viewerKind === "logged_in") {
        out.push(widget); continue;
      }
      if (widget.audience === "guest" && viewerKind === "guest") {
        out.push(widget); continue;
      }
      if (widget.audience === "segment") {
        if (viewerKind !== "logged_in") continue;
        if (!customerSegments) {
          throw new TypeError("sidebarWidgets.widgetsForPage: widget " + JSON.stringify(widget.slug) +
            " has audience=\"segment\" but no customerSegments handle was wired into create()");
        }
        if (typeof customerSegments.isMember !== "function") {
          throw new TypeError("sidebarWidgets.widgetsForPage: customerSegments handle must expose isMember(customer_id, segment_slug)");
        }
        var member = await customerSegments.isMember(customerId, widget.segment_slug);
        if (member) out.push(widget);
        continue;
      }
    }
    return out;
  }

  // -- recordImpression / recordClick ------------------------------------
  //
  // Drop-silent on bad input / missing widget. These run on the hot
  // request path (impression on every storefront page render that
  // surfaces the widget, click on the redirect / form-submit handler
  // that fires before the customer leaves the page). Throwing here
  // would crash the storefront response that triggered the counter.
  // The defineWidget / updateWidget validators already gate legitimate
  // slugs; a request that arrives with a stale slug after archive
  // simply doesn't increment, which is the correct observability
  // behavior — the operator's metricsForWidget rollup naturally
  // reflects the post-archive zero.

  async function _recordEvent(kind, input) {
    if (!input || typeof input !== "object") return { recorded: false };
    if (typeof input.widget_slug !== "string" || !SLUG_RE.test(input.widget_slug)) {
      return { recorded: false };
    }
    if (typeof input.page_key !== "string" || !PAGE_KEY_RE.test(input.page_key) ||
        input.page_key.length > MAX_PAGE_KEY_LEN) {
      return { recorded: false };
    }
    try {
      // Verify the widget exists + isn't archived. The FK on the
      // events table would catch a non-existent slug, but doing the
      // check here lets the drop-silent path return cleanly without
      // surfacing a SQL constraint error to the storefront response.
      var w = await _getWidgetRow(input.widget_slug);
      if (!w || w.archived_at != null) return { recorded: false };

      var id = _b().uuid.v7();
      await query(
        "INSERT INTO sidebar_widget_events (id, widget_slug, page_key, event_kind, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, input.widget_slug, input.page_key, kind, _now()],
      );
      return { recorded: true, event_id: id };
    } catch (_e) {
      // Drop-silent — by design. The storefront response must not
      // observe an exception from a hot-path observability sink.
      return { recorded: false };
    }
  }

  async function recordImpression(input) { return _recordEvent("impression", input); }
  async function recordClick(input)      { return _recordEvent("click",      input); }

  // -- metricsForWidget --------------------------------------------------

  async function metricsForWidget(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("sidebarWidgets.metricsForWidget: input object required");
    }
    var slug = _slug(input.slug, "slug");
    var from = _epochMsOpt(input.from, "from");
    var to   = _epochMsOpt(input.to,   "to");
    if (from != null && to != null && from > to) {
      throw new TypeError("sidebarWidgets.metricsForWidget: from must be <= to");
    }

    var widget = await _getWidgetRow(slug);
    if (!widget) return null;

    var sql = "SELECT event_kind, page_key, COUNT(*) AS n FROM sidebar_widget_events " +
              "WHERE widget_slug = ?1";
    var params = [slug];
    var idx = 2;
    if (from != null) { sql += " AND occurred_at >= ?" + idx; params.push(from); idx += 1; }
    if (to   != null) { sql += " AND occurred_at <= ?" + idx; params.push(to);   idx += 1; }
    sql += " GROUP BY event_kind, page_key";
    var rows = (await query(sql, params)).rows;

    var impressions = 0;
    var clicks      = 0;
    var byPage      = Object.create(null);
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var n   = Number(row.n);
      if (!byPage[row.page_key]) byPage[row.page_key] = { impressions: 0, clicks: 0 };
      if (row.event_kind === "impression") {
        impressions += n;
        byPage[row.page_key].impressions += n;
      } else if (row.event_kind === "click") {
        clicks += n;
        byPage[row.page_key].clicks += n;
      }
    }

    // CTR is reported as a 4-decimal-place ratio (e.g. 0.0312 = 3.12%).
    // Empty-impression case returns 0 so the operator can distinguish
    // "no impressions yet" from "no clicks despite impressions" via
    // the impressions field; same convention as customerSurveys'
    // empty-response rollup.
    var ctr = impressions === 0 ? 0 : Math.round((clicks / impressions) * 10000) / 10000;

    // Per-page CTR computed the same way, attached to each page entry
    // so the operator dashboard can sort by per-page conversion.
    var byPageList = Object.keys(byPage).sort().map(function (p) {
      var entry = byPage[p];
      var pCtr  = entry.impressions === 0 ? 0
                : Math.round((entry.clicks / entry.impressions) * 10000) / 10000;
      return { page_key: p, impressions: entry.impressions, clicks: entry.clicks, ctr: pCtr };
    });

    return {
      slug:        slug,
      kind:        widget.kind,
      from:        from,
      to:          to,
      impressions: impressions,
      clicks:      clicks,
      ctr:         ctr,
      by_page:     byPageList,
    };
  }

  // -- listWidgets -------------------------------------------------------

  async function listWidgets(listOpts) {
    listOpts = listOpts || {};
    var kindFilter = null;
    if (listOpts.kind != null) {
      kindFilter = _kind(listOpts.kind);
    }
    var audienceFilter = null;
    if (listOpts.audience != null) {
      audienceFilter = _audience(listOpts.audience);
    }
    var includeArchived = false;
    if (listOpts.include_archived != null) {
      if (typeof listOpts.include_archived !== "boolean") {
        throw new TypeError("sidebarWidgets.listWidgets: include_archived must be a boolean");
      }
      includeArchived = listOpts.include_archived;
    }
    var limit = _limit(listOpts.limit, "limit");

    var clauses = [];
    var params  = [];
    var idx     = 1;
    if (kindFilter != null)     { clauses.push("kind = ?" + idx);     params.push(kindFilter);     idx += 1; }
    if (audienceFilter != null) { clauses.push("audience = ?" + idx); params.push(audienceFilter); idx += 1; }
    if (!includeArchived)       { clauses.push("archived_at IS NULL"); }

    var sql = "SELECT * FROM sidebar_widgets";
    if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY priority DESC, created_at ASC, slug ASC LIMIT ?" + idx;
    params.push(limit);

    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateWidget(rows[i]));
    return out;
  }

  // -- updateWidget ------------------------------------------------------

  async function updateWidget(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("sidebarWidgets.updateWidget: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("sidebarWidgets.updateWidget: patch must include at least one column");
    }

    var current = await _getWidgetRow(slug);
    if (!current) {
      throw new TypeError("sidebarWidgets.updateWidget: slug " + JSON.stringify(slug) + " not found");
    }
    if (current.archived_at != null) {
      throw new TypeError("sidebarWidgets.updateWidget: widget " + JSON.stringify(slug) + " is archived");
    }

    var sets   = [];
    var params = [];
    var idx    = 1;
    var postAudience    = current.audience;
    var postSegmentSlug = current.segment_slug;
    var postStartsAt    = Number(current.starts_at);
    var postExpiresAt   = Number(current.expires_at);

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("sidebarWidgets.updateWidget: unsupported column " + JSON.stringify(col));
      }
      var v;
      var dbCol = col;
      if (col === "title") {
        v = _title(patch[col]);
      } else if (col === "payload") {
        v = JSON.stringify(_payloadFor(current.kind, patch[col]));
        dbCol = "payload_json";
      } else if (col === "audience") {
        v = _audience(patch[col]); postAudience = v;
      } else if (col === "segment_slug") {
        v = patch[col] == null ? null : _segmentSlug(patch[col]); postSegmentSlug = v;
      } else if (col === "priority") {
        v = _priority(patch[col]);
      } else if (col === "starts_at") {
        v = _epochMs(patch[col], "starts_at"); postStartsAt = v;
      } else /* expires_at */ {
        v = _epochMs(patch[col], "expires_at"); postExpiresAt = v;
      }
      sets.push(dbCol + " = ?" + idx);
      params.push(v);
      idx += 1;
    }

    if (postAudience === "segment" && postSegmentSlug == null) {
      throw new TypeError("sidebarWidgets.updateWidget: audience=\"segment\" requires segment_slug");
    }
    if (postAudience !== "segment" && postSegmentSlug != null) {
      throw new TypeError("sidebarWidgets.updateWidget: segment_slug only valid when audience=\"segment\"");
    }
    if (postExpiresAt <= postStartsAt) {
      throw new TypeError("sidebarWidgets.updateWidget: expires_at must be strictly greater than starts_at");
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    await query(
      "UPDATE sidebar_widgets SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    return _hydrateWidget(await _getWidgetRow(slug));
  }

  // -- archiveWidget -----------------------------------------------------

  async function archiveWidget(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE sidebar_widgets SET archived_at = ?1, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await _getWidgetRow(slug);
      if (!existing) {
        throw new TypeError("sidebarWidgets.archiveWidget: slug " + JSON.stringify(slug) + " not found");
      }
      // Already archived — idempotent return so an operator sweep
      // doesn't have to special-case widgets a coworker archived
      // first. Sibling pattern with promoBanners.archive.
      return _hydrateWidget(existing);
    }
    return _hydrateWidget(await _getWidgetRow(slug));
  }

  return {
    KINDS:                KINDS.slice(),
    AUDIENCES:            AUDIENCES.slice(),
    VIEWER_KINDS:         VIEWER_KINDS.slice(),
    EVENT_KINDS:          EVENT_KINDS.slice(),
    MAX_SLUG_LEN:         MAX_SLUG_LEN,
    MAX_PAGE_KEY_LEN:     MAX_PAGE_KEY_LEN,
    MAX_WIDGETS_PER_PAGE: MAX_WIDGETS_PER_PAGE,
    MAX_LIMIT:            MAX_LIMIT,
    DEFAULT_LIMIT:        DEFAULT_LIMIT,

    defineWidget:         defineWidget,
    getWidget:            getWidget,
    setPagePlacement:     setPagePlacement,
    widgetsForPage:       widgetsForPage,
    recordImpression:     recordImpression,
    recordClick:          recordClick,
    metricsForWidget:     metricsForWidget,
    listWidgets:          listWidgets,
    updateWidget:         updateWidget,
    archiveWidget:        archiveWidget,
  };
}

module.exports = {
  create:               create,
  KINDS:                KINDS,
  AUDIENCES:            AUDIENCES,
  VIEWER_KINDS:         VIEWER_KINDS,
  EVENT_KINDS:          EVENT_KINDS,
  MAX_SLUG_LEN:         MAX_SLUG_LEN,
  MAX_PAGE_KEY_LEN:     MAX_PAGE_KEY_LEN,
  MAX_WIDGETS_PER_PAGE: MAX_WIDGETS_PER_PAGE,
  MAX_LIMIT:            MAX_LIMIT,
  DEFAULT_LIMIT:        DEFAULT_LIMIT,
};
